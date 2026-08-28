-- =============================================================================
-- 0012  Job lifecycle: sending, outcomes, retries, lease recovery
-- =============================================================================
-- The worker reports FACTS (it called Graph; Graph said X). The database makes
-- DECISIONS (retry, fail, suppress, pause the sender, pause the campaign).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Backoff schedule. Exponential with jitter, capped at two hours. Jitter keeps
-- a fleet of retries from re-converging on the same instant.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.retry_delay_seconds(p_attempt integer)
RETURNS integer
LANGUAGE sql VOLATILE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT GREATEST(
    5,
    LEAST(7200, (30 * power(2, GREATEST(p_attempt - 1, 0)))::numeric)
      * (0.8 + random() * 0.4)
  )::integer;
$$;

-- ---------------------------------------------------------------------------
-- claimed -> sending. Opens the attempt record.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.mark_sending(
  p_job_id    uuid,
  p_worker_id text
)
RETURNS TABLE (ok boolean, attempt_no integer, reason_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  j          campaign.email_jobs%ROWTYPE;
  v_attempt  integer;
  v_reason   text;
BEGIN
  SELECT * INTO j FROM campaign.email_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job % not found', p_job_id USING ERRCODE = 'no_data_found';
  END IF;

  IF j.status <> 'claimed' THEN
    RAISE EXCEPTION 'job % is %, expected claimed', p_job_id, j.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF j.locked_by IS DISTINCT FROM p_worker_id THEN
    RAISE EXCEPTION 'job % is leased by %, not %', p_job_id, j.locked_by, p_worker_id
      USING ERRCODE = 'lock_not_available';
  END IF;

  -- Final pre-flight. Between claiming and sending, an emergency stop or an
  -- unsubscribe may have landed; both must win over an in-progress send.
  --
  -- A refusal is RETURNED, not raised: raising would abort the transaction and
  -- roll back the audit row and the denial we are about to record.
  v_reason := campaign.send_denial_reason_for_inflight(p_job_id);
  IF v_reason IS NOT NULL THEN
    PERFORM campaign.write_audit(
      p_action => 'send.refused_preflight', p_entity_type => 'email_job',
      p_entity_id => p_job_id::text, p_campaign_id => j.campaign_id, p_job_id => p_job_id,
      p_actor_type => 'worker', p_actor_label => p_worker_id, p_reason_code => v_reason);

    -- Release the lease, then let apply_denial decide where the job belongs.
    UPDATE campaign.email_jobs
       SET status = 'queued', locked_by = NULL, locked_at = NULL,
           lease_expires_at = NULL, skip_reason = v_reason
     WHERE id = p_job_id;
    PERFORM campaign.apply_denial(p_job_id, v_reason, now());

    RETURN QUERY SELECT false, j.attempt_count, v_reason;
    RETURN;
  END IF;

  v_attempt := j.attempt_count + 1;

  UPDATE campaign.email_jobs
     SET status = 'sending', attempt_count = v_attempt
   WHERE id = p_job_id;

  INSERT INTO campaign.email_job_attempts (job_id, attempt_no, worker_id, outcome)
  VALUES (p_job_id, v_attempt, p_worker_id, 'pending');

  RETURN QUERY SELECT true, v_attempt, NULL::text;
END;
$$;

-- ---------------------------------------------------------------------------
-- Pre-flight re-check. Same authorization function, minus the checks that are
-- necessarily false once a job has been claimed (its status is no longer
-- 'queued', and its backoff gate has already been consumed).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.send_denial_reason_for_inflight(p_job_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  j   campaign.email_jobs%ROWTYPE;
  c   campaign.campaigns%ROWTYPE;
  s   campaign.sender_accounts%ROWTYPE;
  ctl campaign.system_controls%ROWTYPE;
BEGIN
  SELECT * INTO j FROM campaign.email_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN RETURN 'job_not_found'; END IF;

  SELECT * INTO ctl FROM campaign.system_controls WHERE id = true;
  IF ctl.emergency_stop           THEN RETURN 'emergency_stop_engaged'; END IF;
  IF NOT ctl.global_send_enabled  THEN RETURN 'global_send_disabled'; END IF;

  SELECT * INTO c FROM campaign.campaigns WHERE id = j.campaign_id;
  IF NOT FOUND                    THEN RETURN 'campaign_missing'; END IF;
  IF c.status <> 'running'        THEN
    RETURN CASE c.status
             WHEN 'paused'   THEN 'campaign_paused'
             WHEN 'stopping' THEN 'campaign_stopping'
             WHEN 'stopped'  THEN 'campaign_stopped'
             ELSE 'campaign_not_running' END;
  END IF;
  IF c.approved_at IS NULL        THEN RETURN 'campaign_not_approved'; END IF;
  IF j.content_version_hash IS DISTINCT FROM c.approved_content_hash THEN
    RETURN 'content_changed_since_approval';
  END IF;

  IF c.send_mode = 'test' THEN
    IF NOT EXISTS (SELECT 1 FROM campaign.test_recipients tr
                   WHERE tr.email_canonical = campaign.canonical_email(j.recipient_email::text)) THEN
      RETURN 'test_mode_recipient_not_allowed';
    END IF;
  ELSIF NOT ctl.production_mode THEN
    RETURN 'production_mode_disabled';
  END IF;

  SELECT * INTO s FROM campaign.sender_accounts WHERE id = j.sender_account_id;
  IF NOT FOUND                    THEN RETURN 'sender_missing'; END IF;
  IF s.status <> 'active'         THEN
    RETURN CASE s.status WHEN 'paused' THEN 'sender_paused' ELSE 'sender_disabled' END;
  END IF;

  -- An unsubscribe that arrives after claiming still wins.
  IF campaign.is_suppressed(j.recipient_email::text, j.campaign_id) THEN
    RETURN 'recipient_suppressed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM campaign.email_jobs o
    WHERE o.campaign_id = j.campaign_id
      AND o.recipient_email = j.recipient_email
      AND o.id <> j.id
      AND o.status IN ('sent', 'sending', 'needs_reconciliation', 'bounced', 'complained')
  ) THEN
    RETURN 'duplicate_recipient_already_sent';
  END IF;

  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Success. Idempotent: calling it twice for the same job is a recorded no-op,
-- never a second send and never a corrupted counter.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.mark_sent(
  p_job_id              uuid,
  p_worker_id           text,
  p_graph_message_id    text DEFAULT NULL,
  p_internet_message_id text DEFAULT NULL,
  p_http_status         integer DEFAULT NULL,
  p_graph_request_id    text DEFAULT NULL
)
RETURNS boolean   -- true if this call performed the transition
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  j        campaign.email_jobs%ROWTYPE;
  v_now    timestamptz := now();
BEGIN
  SELECT * INTO j FROM campaign.email_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job % not found', p_job_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Duplicate-protection layer 7.
  IF j.status = 'sent' THEN
    PERFORM campaign.write_audit(
      p_action => 'send.duplicate_blocked', p_entity_type => 'email_job',
      p_entity_id => p_job_id::text, p_campaign_id => j.campaign_id, p_job_id => p_job_id,
      p_actor_type => 'worker', p_actor_label => p_worker_id,
      p_reason_code => 'duplicate_send_attempt_blocked',
      p_metadata => jsonb_build_object('already_sent_at', j.sent_at,
                                       'incoming_graph_message_id', p_graph_message_id));
    PERFORM campaign.raise_alert(
      'duplicate_send.' || p_job_id::text, 'critical',
      'Duplicate send attempt blocked',
      format('Job %s was already marked sent at %s; a second completion was reported by %s.',
             p_job_id, j.sent_at, p_worker_id),
      j.campaign_id, j.sender_account_id, p_job_id);
    RETURN false;
  END IF;

  IF j.status NOT IN ('sending', 'needs_reconciliation') THEN
    RAISE EXCEPTION 'job % is %, cannot mark sent', p_job_id, j.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE campaign.email_jobs
     SET status = 'sent',
         sent_at = v_now,
         graph_message_id = COALESCE(p_graph_message_id, graph_message_id),
         internet_message_id = COALESCE(p_internet_message_id, internet_message_id),
         locked_by = NULL, locked_at = NULL, lease_expires_at = NULL,
         skip_reason = NULL, last_error_code = NULL, last_error_message = NULL,
         last_failure_class = NULL
   WHERE id = p_job_id;

  -- Counters move in the SAME transaction as the state change, so a limit can
  -- never be exceeded by a race between two workers.
  INSERT INTO campaign.send_counters (sender_account_id, campaign_id, bucket_hour, sent_count)
  VALUES (j.sender_account_id, j.campaign_id, date_trunc('hour', v_now), 1)
  ON CONFLICT (sender_account_id, campaign_id, bucket_hour)
  DO UPDATE SET sent_count = campaign.send_counters.sent_count + 1, updated_at = v_now;

  UPDATE campaign.email_job_attempts
     SET outcome = 'sent', finished_at = v_now,
         duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (v_now - started_at)) * 1000)::integer),
         http_status = COALESCE(p_http_status, http_status),
         graph_request_id = COALESCE(p_graph_request_id, graph_request_id)
   WHERE job_id = p_job_id AND attempt_no = j.attempt_count;

  -- A success clears the campaign's consecutive-failure run.
  UPDATE campaign.campaigns SET consecutive_failures = 0
   WHERE id = j.campaign_id AND consecutive_failures <> 0;

  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Failure. The worker supplies the classification; the database decides the
-- consequence.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.mark_failed(
  p_job_id            uuid,
  p_worker_id         text,
  p_failure_class     campaign.failure_class,
  p_error_code        text DEFAULT NULL,
  p_error_message     text DEFAULT NULL,
  p_http_status       integer DEFAULT NULL,
  p_graph_request_id  text DEFAULT NULL,
  p_retry_after_seconds integer DEFAULT NULL
)
RETURNS campaign.job_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  j            campaign.email_jobs%ROWTYPE;
  c            campaign.campaigns%ROWTYPE;
  v_now        timestamptz := now();
  v_delay      integer;
  v_final      campaign.job_status;
  v_consecutive     integer;
  v_recent_failures integer;
  v_recent_total    integer;
BEGIN
  SELECT * INTO j FROM campaign.email_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job % not found', p_job_id USING ERRCODE = 'no_data_found';
  END IF;
  IF j.status = 'sent' THEN
    -- A send we already recorded cannot be un-sent by a late failure report.
    PERFORM campaign.write_audit(
      p_action => 'send.late_failure_ignored', p_entity_type => 'email_job',
      p_entity_id => p_job_id::text, p_campaign_id => j.campaign_id, p_job_id => p_job_id,
      p_actor_type => 'worker', p_actor_label => p_worker_id, p_reason_code => p_error_code);
    RETURN 'sent';
  END IF;
  IF j.status NOT IN ('sending', 'claimed') THEN
    RAISE EXCEPTION 'job % is %, cannot mark failed', p_job_id, j.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO c FROM campaign.campaigns WHERE id = j.campaign_id;

  UPDATE campaign.email_job_attempts
     SET outcome = CASE WHEN p_failure_class = 'ambiguous' THEN 'ambiguous' ELSE 'failed' END,
         finished_at = v_now,
         duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (v_now - started_at)) * 1000)::integer),
         http_status = p_http_status,
         graph_request_id = p_graph_request_id,
         failure_class = p_failure_class,
         error_code = p_error_code,
         error_message = left(COALESCE(p_error_message, ''), 4000),
         retry_after_seconds = p_retry_after_seconds
   WHERE job_id = p_job_id AND attempt_no = j.attempt_count;

  -- An outcome we cannot determine is NEVER retried automatically. It goes to
  -- reconciliation, where evidence -- not a guess -- decides.
  IF p_failure_class = 'ambiguous' THEN
    UPDATE campaign.email_jobs
       SET status = 'needs_reconciliation',
           last_failure_class = p_failure_class,
           last_error_code = p_error_code,
           last_error_message = left(COALESCE(p_error_message, ''), 4000),
           locked_by = NULL, locked_at = NULL, lease_expires_at = NULL
     WHERE id = p_job_id;

    PERFORM campaign.raise_alert(
      'needs_reconciliation.' || j.campaign_id::text, 'critical',
      'Send outcome unknown; reconciliation required',
      format('Job %s to %s returned an ambiguous result (%s). It will NOT be retried until reconciled against Sent Items.',
             p_job_id, j.recipient_email, COALESCE(p_error_code, 'no code')),
      j.campaign_id, j.sender_account_id, p_job_id);

    RETURN 'needs_reconciliation';
  END IF;

  IF p_failure_class IN ('retryable_throttle', 'retryable_transient')
     AND j.attempt_count < j.max_attempts THEN

    -- Microsoft's Retry-After is authoritative when present.
    v_delay := COALESCE(p_retry_after_seconds, campaign.retry_delay_seconds(j.attempt_count));

    UPDATE campaign.email_jobs
       SET status = 'failed_retryable',
           last_failure_class = p_failure_class,
           last_error_code = p_error_code,
           last_error_message = left(COALESCE(p_error_message, ''), 4000),
           locked_by = NULL, locked_at = NULL, lease_expires_at = NULL
     WHERE id = p_job_id;

    -- Back into the queue, gated behind the backoff. Two transitions so the
    -- audit trail shows the failure AND the scheduled retry.
    UPDATE campaign.email_jobs
       SET status = 'queued',
           available_at = v_now + make_interval(secs => v_delay),
           skip_reason = 'awaiting_retry'
     WHERE id = p_job_id;

    v_final := 'queued';
  ELSE
    UPDATE campaign.email_jobs
       SET status = 'failed_permanent',
           last_failure_class = p_failure_class,
           last_error_code = p_error_code,
           last_error_message = left(COALESCE(p_error_message, ''), 4000),
           skip_reason = CASE WHEN j.attempt_count >= j.max_attempts
                              THEN 'attempts_exhausted' ELSE p_error_code END,
           locked_by = NULL, locked_at = NULL, lease_expires_at = NULL
     WHERE id = p_job_id;

    v_final := 'failed_permanent';

    -- A bad address is a suppression, not just a failure: never try it again
    -- on any future campaign.
    IF p_failure_class = 'permanent_recipient' THEN
      INSERT INTO campaign.suppressions (email_canonical, reason, scope, source, notes)
      VALUES (campaign.canonical_email(j.recipient_email::text), 'invalid_address', 'global',
              'send_failure', format('Auto-suppressed after permanent recipient failure on job %s: %s',
                                     p_job_id, COALESCE(p_error_code, 'unknown')))
      ON CONFLICT DO NOTHING;
    END IF;

    -- A credential or policy failure is not this recipient's problem -- it is
    -- the mailbox's. Stop the mailbox before it burns through the queue.
    IF p_failure_class IN ('permanent_auth', 'permanent_policy') THEN
      UPDATE campaign.sender_accounts
         SET status = 'paused',
             paused_reason = format('Auto-paused: %s (%s)', p_failure_class, COALESCE(p_error_code, 'no code')),
             paused_at = v_now
       WHERE id = j.sender_account_id AND status = 'active';

      PERFORM campaign.raise_alert(
        'sender_auth_failure.' || j.sender_account_id::text, 'critical',
        'Sending mailbox paused after an authentication/policy failure',
        format('Sender %s was paused because job %s failed with %s (%s). Check the Entra app registration, admin consent, and the Exchange application access policy.',
               j.sender_account_id, p_job_id, p_failure_class, COALESCE(p_error_code, 'no code')),
        j.campaign_id, j.sender_account_id, p_job_id);
    END IF;
  END IF;

  -- Campaign-level failure thresholds: a campaign that is failing badly pauses
  -- itself rather than continuing to damage the mailbox's reputation.
  UPDATE campaign.campaigns
     SET consecutive_failures = consecutive_failures + 1
   WHERE id = j.campaign_id
  RETURNING consecutive_failures INTO v_consecutive;

  SELECT count(*) FILTER (WHERE a.outcome = 'failed'), count(*)
    INTO v_recent_failures, v_recent_total
  FROM (
    SELECT a2.outcome
    FROM campaign.email_job_attempts a2
    JOIN campaign.email_jobs j2 ON j2.id = a2.job_id
    WHERE j2.campaign_id = j.campaign_id AND a2.outcome IN ('sent', 'failed')
    ORDER BY a2.id DESC
    LIMIT c.failure_rate_window
  ) a;

  IF c.status = 'running' AND (
       v_consecutive >= c.failure_threshold_consecutive
       OR (v_recent_total >= c.failure_rate_window
           AND v_recent_failures::numeric / NULLIF(v_recent_total, 0) >= c.failure_threshold_rate)
     )
  THEN
    UPDATE campaign.campaigns
       SET status = 'paused',
           paused_reason = format('Auto-paused: failure threshold exceeded (%s consecutive, %s/%s recent)',
                                  v_consecutive, v_recent_failures, v_recent_total),
           paused_at = v_now
     WHERE id = j.campaign_id;

    PERFORM campaign.raise_alert(
      'campaign_failure_threshold.' || j.campaign_id::text, 'critical',
      'Campaign auto-paused on failure threshold',
      format('Campaign %s exceeded its failure threshold and was paused automatically.', c.name),
      j.campaign_id, j.sender_account_id, NULL);
  END IF;

  RETURN v_final;
END;
$$;
