-- =============================================================================
-- 0009  Email state machine
-- =============================================================================
-- Legal transitions are DATA, not scattered application logic, and a trigger
-- refuses anything not listed. An illegal transition raises an exception; it
-- never silently succeeds.
-- =============================================================================

CREATE TABLE campaign.allowed_transitions (
  from_status campaign.job_status NOT NULL,
  to_status   campaign.job_status NOT NULL,
  note        text,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO campaign.allowed_transitions (from_status, to_status, note) VALUES
  -- Materialized, waiting to be released into the queue.
  ('pending',              'queued',               'campaign started / released'),
  ('pending',              'suppressed',           'recipient on suppression list'),
  ('pending',              'cancelled',            'campaign stopped or recipient removed'),
  ('pending',              'held',                 'operator hold'),
  ('pending',              'skipped',              'campaign ended before release'),

  -- Eligible for claiming.
  ('queued',               'claimed',              'worker took a lease'),
  ('queued',               'suppressed',           'suppression landed while queued'),
  ('queued',               'cancelled',            'campaign stopped or recipient removed'),
  ('queued',               'held',                 'operator hold'),
  ('queued',               'skipped',              'campaign ended before it became eligible'),
  ('queued',               'failed_permanent',     'attempt budget exhausted'),

  -- Leased by a worker.
  ('claimed',              'sending',              'handed to Microsoft Graph'),
  ('claimed',              'queued',               'lease released on graceful shutdown or reaped'),
  ('claimed',              'failed_retryable',     'failed before the request was made'),
  ('claimed',              'failed_permanent',     'refused before the request was made'),
  ('claimed',              'cancelled',            'campaign stopped mid-lease'),
  ('claimed',              'suppressed',           'unsubscribe landed while leased'),

  -- Request in flight. Note there is deliberately NO sending -> queued edge:
  -- a request that may have been delivered must never be silently retried.
  ('sending',              'sent',                 'Graph accepted the message'),
  ('sending',              'failed_retryable',     'Graph refused, retryable'),
  ('sending',              'failed_permanent',     'Graph refused, permanent'),
  ('sending',              'needs_reconciliation', 'outcome unknown; resolve against Sent Items'),

  -- Retry loop.
  ('failed_retryable',     'queued',               'backoff elapsed'),
  ('failed_retryable',     'failed_permanent',     'attempt budget exhausted'),
  ('failed_retryable',     'cancelled',            'campaign stopped'),
  ('failed_retryable',     'held',                 'operator hold'),
  ('failed_retryable',     'skipped',              'campaign ended before the retry landed'),

  -- Ambiguous outcome resolution.
  ('needs_reconciliation', 'sent',                 'found in Sent Items'),
  ('needs_reconciliation', 'failed_permanent',     'confirmed not sent and not retryable'),
  ('needs_reconciliation', 'queued',               'confirmed NOT sent; safe to retry'),
  ('needs_reconciliation', 'cancelled',            'campaign stopped'),

  -- Operator hold.
  ('held',                 'queued',               'hold released'),
  ('held',                 'cancelled',            'campaign stopped'),
  ('held',                 'suppressed',           'suppression landed while held'),

  -- Post-delivery signals.
  ('sent',                 'bounced',              'hard bounce reported after delivery'),
  ('sent',                 'complained',           'recipient reported spam'),

  -- Operator-initiated recovery of a permanently failed job. Allowed, but it
  -- goes through campaign.requeue_job() which audits who did it and why.
  ('failed_permanent',     'queued',               'explicit operator requeue'),
  ('skipped',              'queued',               'campaign window extended / restarted'),
  ('suppressed',           'cancelled',            'campaign stopped');

COMMENT ON TABLE campaign.allowed_transitions IS
  'The email state machine. Enforced by campaign.enforce_job_transition(); there is no sending -> queued edge by design.';

-- Terminal states never move again.
CREATE OR REPLACE FUNCTION campaign.is_terminal_status(p campaign.job_status)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT p IN ('cancelled', 'bounced', 'complained');
$$;

-- -----------------------------------------------------------------------------
-- The enforcing trigger.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.enforce_job_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = campaign, public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (
      SELECT 1 FROM campaign.allowed_transitions t
      WHERE t.from_status = OLD.status AND t.to_status = NEW.status
    ) THEN
      RAISE EXCEPTION
        'illegal email_jobs transition % -> % for job %',
        OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'check_violation',
              HINT = 'Permitted transitions are listed in campaign.allowed_transitions.';
    END IF;

    -- Every transition is recorded. This is what makes the audit trail complete
    -- rather than best-effort: it cannot be bypassed by any code path.
    PERFORM campaign.write_audit(
      p_action      => 'email_job.transition',
      p_entity_type => 'email_job',
      p_entity_id   => NEW.id::text,
      p_campaign_id => NEW.campaign_id,
      p_job_id      => NEW.id,
      p_reason_code => COALESCE(NEW.skip_reason, NEW.last_error_code),
      p_before      => jsonb_build_object('status', OLD.status, 'attempt_count', OLD.attempt_count),
      p_after       => jsonb_build_object(
                         'status', NEW.status,
                         'attempt_count', NEW.attempt_count,
                         'locked_by', NEW.locked_by,
                         'available_at', NEW.available_at
                       )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER email_jobs_enforce_transition
  BEFORE UPDATE OF status ON campaign.email_jobs
  FOR EACH ROW EXECUTE FUNCTION campaign.enforce_job_transition();

-- Serving the min-gap and rate-limit lookups on the claim hot path.
CREATE INDEX email_jobs_sender_sent_idx
  ON campaign.email_jobs (sender_account_id, sent_at DESC)
  WHERE status = 'sent';
