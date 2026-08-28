-- =============================================================================
-- 0011  Atomic job claiming
-- =============================================================================
-- The ONLY way a worker can obtain a sendable email. Every candidate row is
-- locked with FOR UPDATE ... SKIP LOCKED and then re-checked against
-- campaign.send_denial_reason() inside the same transaction, so:
--
--   * two workers can never hold the same job, and
--   * a job that is not authorized at this instant is never handed out,
--     no matter what caused the worker to run.
-- =============================================================================

-- When does this campaign's window next open? Used to park a job that is
-- outside its window instead of re-testing it every few seconds.
CREATE OR REPLACE FUNCTION campaign.next_window_open(
  p_campaign_id uuid,
  p_at timestamptz DEFAULT now()
)
RETURNS timestamptz
LANGUAGE plpgsql STABLE
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  sch         campaign.campaign_schedules%ROWTYPE;
  d           integer;
  v_local_day date;
  v_candidate timestamptz;
BEGIN
  SELECT * INTO sch FROM campaign.campaign_schedules WHERE campaign_id = p_campaign_id;
  IF NOT FOUND THEN
    RETURN p_at + interval '1 hour';
  END IF;

  -- Look ahead a little over a week; any weekly pattern must recur inside that.
  FOR d IN 0..8 LOOP
    v_local_day := (p_at AT TIME ZONE sch.timezone)::date + d;
    IF EXTRACT(ISODOW FROM v_local_day)::smallint = ANY (sch.allowed_days) THEN
      v_candidate := ((v_local_day + sch.window_start) AT TIME ZONE sch.timezone);
      IF v_candidate > p_at THEN
        IF sch.start_at IS NOT NULL AND v_candidate < sch.start_at THEN
          v_candidate := sch.start_at;
        END IF;
        IF sch.end_at IS NOT NULL AND v_candidate >= sch.end_at THEN
          RETURN NULL;   -- the campaign's window closes before this opens again
        END IF;
        RETURN v_candidate;
      END IF;
    END IF;
  END LOOP;

  RETURN p_at + interval '1 hour';
END;
$$;

-- ---------------------------------------------------------------------------
-- What to do with a job the authorization function just refused.
-- Soft refusals park the job until the condition can plausibly have cleared.
-- Hard refusals move it out of the queue entirely.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.apply_denial(
  p_job_id uuid,
  p_reason text,
  p_at     timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  j          campaign.email_jobs%ROWTYPE;
  v_next     timestamptz;
  v_severity text := campaign.denial_severity(p_reason);
BEGIN
  SELECT * INTO j FROM campaign.email_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_severity = 'hard' THEN
    IF p_reason = 'recipient_suppressed' THEN
      UPDATE campaign.email_jobs
         SET status = 'suppressed',
             suppressed_reason = campaign.suppression_reason_for(j.recipient_email::text, j.campaign_id),
             skip_reason = p_reason,
             locked_by = NULL, locked_at = NULL, lease_expires_at = NULL
       WHERE id = p_job_id;

    ELSIF p_reason IN ('campaign_stopped', 'campaign_stopping') THEN
      UPDATE campaign.email_jobs
         SET status = 'cancelled', skip_reason = p_reason,
             locked_by = NULL, locked_at = NULL, lease_expires_at = NULL
       WHERE id = p_job_id;

    ELSIF p_reason = 'campaign_window_ended' THEN
      UPDATE campaign.email_jobs
         SET status = 'skipped', skip_reason = p_reason,
             locked_by = NULL, locked_at = NULL, lease_expires_at = NULL
       WHERE id = p_job_id;

    ELSE
      -- attempts_exhausted, duplicate_recipient_already_sent,
      -- content_changed_since_approval
      UPDATE campaign.email_jobs
         SET status = 'failed_permanent', skip_reason = p_reason,
             locked_by = NULL, locked_at = NULL, lease_expires_at = NULL
       WHERE id = p_job_id;
    END IF;
    RETURN;
  END IF;

  -- Soft refusal: stay queued, but park until the condition can have changed.
  v_next := CASE p_reason
    WHEN 'outside_sending_window'   THEN COALESCE(campaign.next_window_open(j.campaign_id, p_at), p_at + interval '1 hour')
    WHEN 'campaign_not_started'     THEN COALESCE(campaign.next_window_open(j.campaign_id, p_at), p_at + interval '1 hour')
    WHEN 'sender_hourly_limit_reached'   THEN date_trunc('hour', p_at) + interval '1 hour'
    WHEN 'campaign_hourly_limit_reached' THEN date_trunc('hour', p_at) + interval '1 hour'
    WHEN 'sender_daily_limit_reached'    THEN COALESCE(campaign.next_window_open(j.campaign_id, p_at), p_at + interval '1 hour')
    WHEN 'campaign_daily_limit_reached'  THEN COALESCE(campaign.next_window_open(j.campaign_id, p_at), p_at + interval '1 hour')
    WHEN 'min_send_gap_not_elapsed' THEN p_at + interval '5 seconds'
    WHEN 'campaign_paused'          THEN p_at + interval '60 seconds'
    WHEN 'sender_paused'            THEN p_at + interval '120 seconds'
    WHEN 'sender_disabled'          THEN p_at + interval '10 minutes'
    WHEN 'test_mode_recipient_not_allowed' THEN p_at + interval '10 minutes'
    WHEN 'production_mode_disabled' THEN p_at + interval '10 minutes'
    WHEN 'campaign_not_approved'    THEN p_at + interval '5 minutes'
    ELSE p_at + interval '60 seconds'
  END;

  -- skip_reason is updated so the UI can always answer "why isn't this moving?"
  UPDATE campaign.email_jobs
     SET skip_reason = p_reason,
         available_at = GREATEST(v_next, p_at + interval '1 second')
   WHERE id = p_job_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- claim_email_jobs : the execution plane's single entry point.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.claim_email_jobs(
  p_worker_id        text,
  p_limit            integer DEFAULT 10,
  p_lease_seconds    integer DEFAULT 120,
  p_sender_account_id uuid DEFAULT NULL
)
RETURNS SETOF campaign.email_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  v_candidate uuid;
  v_reason    text;
  v_claimed   integer := 0;
  v_at        timestamptz := now();
  ctl         campaign.system_controls%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'claim_email_jobs requires a worker id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'claim limit must be between 1 and 500' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 10 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease seconds must be between 10 and 3600' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO ctl FROM campaign.system_controls WHERE id = true;

  -- Global stops short-circuit before any row is touched. Nothing is claimed,
  -- nothing is mutated, and the reason is on the record.
  IF ctl.emergency_stop OR NOT ctl.global_send_enabled THEN
    PERFORM campaign.write_audit(
      p_action      => 'claim.refused',
      p_actor_type  => 'worker',
      p_actor_label => p_worker_id,
      p_reason_code => CASE WHEN ctl.emergency_stop THEN 'emergency_stop_engaged'
                            ELSE 'global_send_disabled' END
    );
    RETURN;
  END IF;

  -- Candidates are locked first (SKIP LOCKED makes concurrent workers disjoint),
  -- then authorized one by one. We look at more rows than we need because some
  -- will be refused.
  FOR v_candidate IN
    SELECT j.id
    FROM campaign.email_jobs j
    WHERE j.status = 'queued'
      AND j.available_at <= v_at
      AND (p_sender_account_id IS NULL OR j.sender_account_id = p_sender_account_id)
    ORDER BY j.priority, j.scheduled_for, j.created_at
    LIMIT LEAST(GREATEST(p_limit * 4, p_limit), 2000)
    FOR UPDATE OF j SKIP LOCKED
  LOOP
    EXIT WHEN v_claimed >= p_limit;

    v_reason := campaign.send_denial_reason(v_candidate, v_at);

    IF v_reason IS NULL THEN
      UPDATE campaign.email_jobs
         SET status           = 'claimed',
             locked_by        = p_worker_id,
             locked_at        = v_at,
             lease_expires_at = v_at + make_interval(secs => p_lease_seconds),
             skip_reason      = NULL
       WHERE id = v_candidate;

      v_claimed := v_claimed + 1;
      RETURN QUERY SELECT * FROM campaign.email_jobs WHERE id = v_candidate;
    ELSE
      PERFORM campaign.apply_denial(v_candidate, v_reason, v_at);
    END IF;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION campaign.claim_email_jobs(text, integer, integer, uuid) IS
  'Atomically leases authorized jobs. The only supported way to obtain a sendable email. Re-checks authorization inside the locking transaction.';
