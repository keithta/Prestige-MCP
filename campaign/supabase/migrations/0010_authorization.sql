-- =============================================================================
-- 0010  SENDING AUTHORIZATION  --  the single choke point
-- =============================================================================
-- campaign.send_denial_reason() is the ONE definition of "may this specific
-- email be sent right now". It returns NULL when the send is authorized, or a
-- machine-readable reason code when it is not.
--
-- It is called:
--   * inside the claim transaction, on every candidate row; and
--   * again immediately before the Graph call (worker calls authorize_send()).
--
-- No other code -- not the worker, not the UI, not n8n -- is permitted to form
-- its own opinion about eligibility.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Volume accounting helpers. Day boundaries are computed in the SENDER's
-- timezone, so "500 a day" means the sender's day, not UTC's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.local_day_start(p_at timestamptz, p_tz text)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT (date_trunc('day', p_at AT TIME ZONE p_tz) AT TIME ZONE p_tz);
$$;

CREATE OR REPLACE FUNCTION campaign.sender_sent_in_hour(p_sender uuid, p_at timestamptz DEFAULT now())
RETURNS integer
LANGUAGE sql STABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT COALESCE(SUM(c.sent_count), 0)::integer
  FROM campaign.send_counters c
  WHERE c.sender_account_id = p_sender
    AND c.bucket_hour = date_trunc('hour', p_at);
$$;

CREATE OR REPLACE FUNCTION campaign.sender_sent_today(p_sender uuid, p_at timestamptz DEFAULT now())
RETURNS integer
LANGUAGE sql STABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT COALESCE(SUM(c.sent_count), 0)::integer
  FROM campaign.send_counters c
  JOIN campaign.sender_accounts s ON s.id = c.sender_account_id
  WHERE c.sender_account_id = p_sender
    AND c.bucket_hour >= campaign.local_day_start(p_at, s.timezone)
    AND c.bucket_hour <= p_at;
$$;

CREATE OR REPLACE FUNCTION campaign.campaign_sent_in_hour(p_campaign uuid, p_at timestamptz DEFAULT now())
RETURNS integer
LANGUAGE sql STABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT COALESCE(SUM(c.sent_count), 0)::integer
  FROM campaign.send_counters c
  WHERE c.campaign_id = p_campaign
    AND c.bucket_hour = date_trunc('hour', p_at);
$$;

CREATE OR REPLACE FUNCTION campaign.campaign_sent_today(p_campaign uuid, p_at timestamptz DEFAULT now())
RETURNS integer
LANGUAGE sql STABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT COALESCE(SUM(c.sent_count), 0)::integer
  FROM campaign.send_counters c
  JOIN campaign.campaign_schedules sc ON sc.campaign_id = c.campaign_id
  WHERE c.campaign_id = p_campaign
    AND c.bucket_hour >= campaign.local_day_start(p_at, sc.timezone)
    AND c.bucket_hour <= p_at;
$$;

-- ---------------------------------------------------------------------------
-- THE AUTHORIZATION FUNCTION
--
-- Returns NULL  => authorized to send right now.
-- Returns text  => reason code explaining the refusal.
--
-- Checks are ordered cheapest-and-most-absolute first, so an emergency stop
-- short-circuits before any per-recipient work happens.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.send_denial_reason(
  p_job_id uuid,
  p_at     timestamptz DEFAULT now()
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  j   campaign.email_jobs%ROWTYPE;
  c   campaign.campaigns%ROWTYPE;
  s   campaign.sender_accounts%ROWTYPE;
  sch campaign.campaign_schedules%ROWTYPE;
  ctl campaign.system_controls%ROWTYPE;
  v_last_sent_at timestamptz;
BEGIN
  SELECT * INTO j FROM campaign.email_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    RETURN 'job_not_found';
  END IF;

  SELECT * INTO ctl FROM campaign.system_controls WHERE id = true;

  -- (1) Global emergency stop.
  IF ctl.emergency_stop THEN
    RETURN 'emergency_stop_engaged';
  END IF;

  -- (2) Global send enable.
  IF NOT ctl.global_send_enabled THEN
    RETURN 'global_send_disabled';
  END IF;

  -- (5) Job must be queued and past its backoff gate.
  --     (Checked early because it is the cheapest per-job filter.)
  IF j.status <> 'queued' THEN
    RETURN 'job_not_queued';
  END IF;
  IF j.available_at > p_at THEN
    RETURN 'backoff_not_elapsed';
  END IF;

  -- (10) Attempt budget.
  IF j.attempt_count >= j.max_attempts THEN
    RETURN 'attempts_exhausted';
  END IF;

  SELECT * INTO c FROM campaign.campaigns WHERE id = j.campaign_id;
  IF NOT FOUND THEN
    RETURN 'campaign_missing';
  END IF;

  -- (3) Campaign must be actively running. Paused, stopped, draft, completed
  --     and every other state refuse.
  IF c.status <> 'running' THEN
    RETURN CASE c.status
             WHEN 'paused'   THEN 'campaign_paused'
             WHEN 'stopping' THEN 'campaign_stopping'
             WHEN 'stopped'  THEN 'campaign_stopped'
             ELSE 'campaign_not_running'
           END;
  END IF;

  -- (4) Approval, bound to exact content. A post-approval edit changes the
  --     campaign's approved hash (or clears approval), and every job built
  --     from the old content stops being authorized.
  IF c.approved_at IS NULL OR c.approved_content_hash IS NULL THEN
    RETURN 'campaign_not_approved';
  END IF;
  IF j.content_version_hash IS DISTINCT FROM c.approved_content_hash THEN
    RETURN 'content_changed_since_approval';
  END IF;

  -- (12) Mode gates. Test mode can only reach the allowlist; production mode
  --      additionally requires the global production switch to be on.
  IF c.send_mode = 'test' THEN
    IF NOT EXISTS (
      SELECT 1 FROM campaign.test_recipients tr
      WHERE tr.email_canonical = campaign.canonical_email(j.recipient_email::text)
    ) THEN
      RETURN 'test_mode_recipient_not_allowed';
    END IF;
  ELSE
    IF NOT ctl.production_mode THEN
      RETURN 'production_mode_disabled';
    END IF;
  END IF;

  -- (6) Sender account must be active, and must belong to the campaign.
  SELECT * INTO s FROM campaign.sender_accounts WHERE id = j.sender_account_id;
  IF NOT FOUND THEN
    RETURN 'sender_missing';
  END IF;
  IF s.status <> 'active' THEN
    RETURN CASE s.status WHEN 'paused' THEN 'sender_paused' ELSE 'sender_disabled' END;
  END IF;
  IF s.id <> c.sender_account_id THEN
    RETURN 'sender_mismatch';
  END IF;

  -- (8) Suppression. Checked here AND again by the worker immediately before
  --     the Graph call, so an unsubscribe that lands mid-flight still wins.
  IF campaign.is_suppressed(j.recipient_email::text, j.campaign_id) THEN
    RETURN 'recipient_suppressed';
  END IF;

  -- (11) Duplicate protection: nothing else in this campaign may already have
  --      gone to this address. The unique indexes make this near-impossible;
  --      this check makes it provably impossible.
  IF EXISTS (
    SELECT 1 FROM campaign.email_jobs o
    WHERE o.campaign_id = j.campaign_id
      AND o.recipient_email = j.recipient_email
      AND o.id <> j.id
      AND o.status IN ('sent', 'sending', 'needs_reconciliation', 'bounced', 'complained')
  ) THEN
    RETURN 'duplicate_recipient_already_sent';
  END IF;

  -- (7) Schedule window: allowed days and hours, in the campaign's timezone.
  SELECT * INTO sch FROM campaign.campaign_schedules WHERE campaign_id = j.campaign_id;
  IF NOT FOUND THEN
    RETURN 'schedule_missing';
  END IF;
  IF sch.start_at IS NOT NULL AND p_at < sch.start_at THEN
    RETURN 'campaign_not_started';
  END IF;
  IF sch.end_at IS NOT NULL AND p_at >= sch.end_at THEN
    RETURN 'campaign_window_ended';
  END IF;
  IF NOT campaign.is_within_window(j.campaign_id, p_at) THEN
    RETURN 'outside_sending_window';
  END IF;

  -- (9) Rate limits: sender and campaign, hourly and daily.
  IF campaign.sender_sent_in_hour(s.id, p_at) >= s.hourly_limit THEN
    RETURN 'sender_hourly_limit_reached';
  END IF;
  IF campaign.sender_sent_today(s.id, p_at) >= s.daily_limit THEN
    RETURN 'sender_daily_limit_reached';
  END IF;
  IF campaign.campaign_sent_in_hour(c.id, p_at) >= sch.emails_per_hour THEN
    RETURN 'campaign_hourly_limit_reached';
  END IF;
  IF campaign.campaign_sent_today(c.id, p_at) >= sch.emails_per_day THEN
    RETURN 'campaign_daily_limit_reached';
  END IF;

  -- Pacing: keep a minimum gap between sends from the same mailbox so we stay
  -- well under Exchange Online's per-minute throttling.
  SELECT max(o.sent_at) INTO v_last_sent_at
  FROM campaign.email_jobs o
  WHERE o.sender_account_id = s.id AND o.status = 'sent';

  IF v_last_sent_at IS NOT NULL
     AND GREATEST(s.min_interval_seconds, sch.min_gap_seconds) > 0
     AND p_at < v_last_sent_at + make_interval(secs => GREATEST(s.min_interval_seconds, sch.min_gap_seconds))
  THEN
    RETURN 'min_send_gap_not_elapsed';
  END IF;

  -- Authorized.
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION campaign.send_denial_reason(uuid, timestamptz) IS
  'THE authorization decision. NULL = authorized. Any non-null value is a machine-readable refusal reason. Never bypass this.';

-- ---------------------------------------------------------------------------
-- Public form used by the worker as its final pre-flight check, and by the UI
-- to explain why a job is not moving.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.authorize_send(p_job_id uuid, p_at timestamptz DEFAULT now())
RETURNS TABLE (authorized boolean, reason_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
  SELECT r IS NULL, r FROM campaign.send_denial_reason(p_job_id, p_at) AS r;
$$;

-- ---------------------------------------------------------------------------
-- Classification of a refusal.
--   'hard' -- the job's own status must change; it will not become sendable
--             on its own.
--   'soft' -- the job stays queued; the condition is expected to clear with
--             time (a window opening, a rate bucket rolling over).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.denial_severity(p_reason text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT CASE p_reason
    WHEN 'recipient_suppressed'              THEN 'hard'
    WHEN 'attempts_exhausted'                THEN 'hard'
    WHEN 'duplicate_recipient_already_sent'  THEN 'hard'
    WHEN 'campaign_stopped'                  THEN 'hard'
    WHEN 'campaign_stopping'                 THEN 'hard'
    WHEN 'content_changed_since_approval'    THEN 'hard'
    WHEN 'campaign_window_ended'             THEN 'hard'
    ELSE 'soft'
  END;
$$;
