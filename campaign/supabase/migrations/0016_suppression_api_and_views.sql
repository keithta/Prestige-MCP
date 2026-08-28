-- =============================================================================
-- 0016  Suppression API and reporting views
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Adding a suppression is idempotent and takes effect immediately: any queued
-- job for that address is moved out of the queue in the same transaction, so an
-- unsubscribe cannot be beaten by a send that was already scheduled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.add_suppression(
  p_email       text,
  p_reason      campaign.suppression_reason,
  p_scope       campaign.suppression_scope DEFAULT 'global',
  p_campaign_id uuid DEFAULT NULL,
  p_source      text DEFAULT 'manual',
  p_notes       text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  v_canonical citext := campaign.canonical_email(p_email);
  v_id        uuid;
  v_affected  integer := 0;
BEGIN
  IF v_canonical IS NULL OR position('@' IN v_canonical::text) = 0 THEN
    RAISE EXCEPTION 'invalid email address: %', p_email USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_scope = 'campaign') <> (p_campaign_id IS NOT NULL) THEN
    RAISE EXCEPTION 'campaign-scoped suppressions require a campaign id (and global ones must not have one)'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id INTO v_id FROM campaign.suppressions
   WHERE email_canonical = v_canonical AND revoked_at IS NULL AND scope = p_scope
     AND (p_campaign_id IS NULL OR campaign_id = p_campaign_id);

  IF v_id IS NULL THEN
    INSERT INTO campaign.suppressions
      (email_canonical, reason, scope, campaign_id, source, notes, created_by)
    VALUES (v_canonical, p_reason, p_scope, p_campaign_id, p_source, p_notes, campaign.current_user_id())
    RETURNING id INTO v_id;
  END IF;

  -- Take effect on anything already in flight for this address.
  WITH stopped AS (
    UPDATE campaign.email_jobs j
       SET status = 'suppressed', suppressed_reason = p_reason,
           skip_reason = 'recipient_suppressed',
           locked_by = NULL, locked_at = NULL, lease_expires_at = NULL
     WHERE j.recipient_email = v_canonical
       -- 'sending' is deliberately excluded: that request may already have been
       -- delivered, and rewriting its state would lose the record of a real send.
       AND j.status IN ('pending', 'queued', 'held', 'claimed')
       AND (p_scope = 'global' OR j.campaign_id = p_campaign_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_affected FROM stopped;

  PERFORM campaign.write_audit(
    p_action => 'suppression.added', p_entity_type => 'suppression', p_entity_id => v_id::text,
    p_campaign_id => p_campaign_id, p_reason_code => p_reason::text,
    p_metadata => jsonb_build_object('email', v_canonical, 'scope', p_scope,
                                     'source', p_source, 'jobs_suppressed', v_affected));

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION campaign.revoke_suppression(p_suppression_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  s campaign.suppressions%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'a reason is required to revoke a suppression' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO s FROM campaign.suppressions WHERE id = p_suppression_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'suppression % not found', p_suppression_id USING ERRCODE = 'no_data_found';
  END IF;

  -- An unsubscribe is a legal request, not an operational preference. Revoking
  -- one requires documented re-consent, so it is blocked here outright.
  IF s.reason IN ('unsubscribe', 'complaint') THEN
    RAISE EXCEPTION 'suppressions created by an unsubscribe or a spam complaint cannot be revoked'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Re-add the contact only with documented, verifiable re-consent.';
  END IF;

  UPDATE campaign.suppressions
     SET revoked_at = now(), revoked_by = campaign.current_user_id(), revoke_reason = p_reason
   WHERE id = p_suppression_id;

  PERFORM campaign.write_audit(
    p_action => 'suppression.revoked', p_entity_type => 'suppression',
    p_entity_id => p_suppression_id::text, p_reason_code => 'operator_revoked',
    p_metadata => jsonb_build_object('reason', p_reason, 'email', s.email_canonical));

  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Reporting views
-- ---------------------------------------------------------------------------

-- Why is this job not moving? A single derived answer for the UI, so the
-- operator never has to reason about the interaction of five different gates.
CREATE OR REPLACE VIEW campaign.job_monitor AS
SELECT
  j.id,
  j.campaign_id,
  c.name              AS campaign_name,
  c.status            AS campaign_status,
  c.send_mode,
  j.contact_id,
  j.recipient_email,
  j.recipient_name,
  j.subject,
  j.status,
  j.attempt_count,
  j.max_attempts,
  j.scheduled_for,
  j.available_at,
  j.sent_at,
  j.locked_by,
  j.lease_expires_at,
  j.graph_message_id,
  j.internet_message_id,
  j.last_error_code,
  j.last_error_message,
  j.last_failure_class,
  j.skip_reason,
  j.suppressed_reason,
  j.created_at,
  j.updated_at,
  s.mailbox_address   AS sender_mailbox,
  s.status            AS sender_status,
  CASE
    WHEN j.status = 'queued' AND j.attempt_count > 0 AND j.available_at > now() THEN 'retrying'
    WHEN j.status = 'queued' AND j.available_at > now()                          THEN 'waiting'
    WHEN j.status = 'queued'                                                     THEN 'ready'
    ELSE j.status::text
  END AS effective_state,
  -- Live authorization answer, so "ready" always means genuinely ready.
  CASE WHEN j.status = 'queued' THEN campaign.send_denial_reason(j.id) ELSE NULL END
    AS current_denial_reason
FROM campaign.email_jobs j
JOIN campaign.campaigns c        ON c.id = j.campaign_id
JOIN campaign.sender_accounts s  ON s.id = j.sender_account_id;

CREATE OR REPLACE VIEW campaign.campaign_progress AS
SELECT
  c.id                AS campaign_id,
  c.name,
  c.status,
  c.send_mode,
  c.approved_at,
  c.started_at,
  c.target_count,
  s.mailbox_address   AS sender_mailbox,
  count(j.*)                                                        AS total_jobs,
  count(*) FILTER (WHERE j.status = 'sent')                         AS sent,
  count(*) FILTER (WHERE j.status IN ('pending', 'queued'))         AS remaining,
  count(*) FILTER (WHERE j.status = 'queued' AND j.attempt_count > 0) AS retrying,
  count(*) FILTER (WHERE j.status IN ('claimed', 'sending'))        AS in_flight,
  count(*) FILTER (WHERE j.status = 'failed_permanent')             AS failed,
  count(*) FILTER (WHERE j.status = 'suppressed')                   AS suppressed,
  count(*) FILTER (WHERE j.status = 'cancelled')                    AS cancelled,
  count(*) FILTER (WHERE j.status = 'skipped')                      AS skipped,
  count(*) FILTER (WHERE j.status = 'needs_reconciliation')         AS needs_reconciliation,
  count(*) FILTER (WHERE j.status = 'bounced')                      AS bounced,
  max(j.sent_at)                                                    AS last_sent_at,
  campaign.is_within_window(c.id)                                   AS in_window,
  campaign.next_window_open(c.id)                                   AS next_window_open
FROM campaign.campaigns c
JOIN campaign.sender_accounts s ON s.id = c.sender_account_id
LEFT JOIN campaign.email_jobs j ON j.campaign_id = c.id
GROUP BY c.id, c.name, c.status, c.send_mode, c.approved_at, c.started_at,
         c.target_count, s.mailbox_address;

CREATE OR REPLACE VIEW campaign.queue_health AS
SELECT
  (SELECT count(*) FROM campaign.email_jobs WHERE status = 'queued')                        AS queued,
  (SELECT count(*) FROM campaign.email_jobs WHERE status = 'queued' AND available_at <= now()) AS ready_now,
  (SELECT count(*) FROM campaign.email_jobs WHERE status IN ('claimed', 'sending'))         AS in_flight,
  (SELECT count(*) FROM campaign.email_jobs WHERE status = 'needs_reconciliation')          AS needs_reconciliation,
  (SELECT count(*) FROM campaign.email_jobs
     WHERE status IN ('claimed', 'sending') AND lease_expires_at < now())                   AS expired_leases,
  (SELECT min(available_at) FROM campaign.email_jobs WHERE status = 'queued')               AS oldest_available_at,
  (SELECT count(*) FROM campaign.email_jobs WHERE status = 'sent' AND sent_at >= now() - interval '1 hour') AS sent_last_hour,
  (SELECT count(*) FROM campaign.email_jobs WHERE status = 'sent' AND sent_at >= now() - interval '24 hours') AS sent_last_24h,
  (SELECT count(*) FROM campaign.alerts WHERE resolved_at IS NULL AND severity = 'critical') AS open_critical_alerts,
  (SELECT emergency_stop FROM campaign.system_controls WHERE id = true)                      AS emergency_stop,
  (SELECT global_send_enabled FROM campaign.system_controls WHERE id = true)                 AS global_send_enabled,
  (SELECT production_mode FROM campaign.system_controls WHERE id = true)                     AS production_mode;

-- Per-sender capacity remaining right now: the numbers the operator actually
-- needs to answer "can this campaign finish today?".
CREATE OR REPLACE VIEW campaign.sender_capacity AS
SELECT
  s.id AS sender_account_id,
  s.mailbox_address,
  s.status,
  s.hourly_limit,
  s.daily_limit,
  campaign.sender_sent_in_hour(s.id) AS sent_this_hour,
  campaign.sender_sent_today(s.id)   AS sent_today,
  GREATEST(s.hourly_limit - campaign.sender_sent_in_hour(s.id), 0) AS hourly_remaining,
  GREATEST(s.daily_limit  - campaign.sender_sent_today(s.id), 0)   AS daily_remaining
FROM campaign.sender_accounts s;
