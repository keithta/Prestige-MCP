-- =============================================================================
-- 0015  Campaign and system controls
-- =============================================================================
-- Approve, start, pause, resume, stop, emergency stop. Every one of these is a
-- database function so the rule lives in one place and the audit row cannot be
-- forgotten by a caller.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Compliance gate. A campaign cannot be approved unless its content carries an
-- unsubscribe mechanism and a physical postal address. This is deliberate
-- friction: CAN-SPAM and CASL both require them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.compliance_problems(p_campaign_id uuid)
RETURNS text[]
LANGUAGE plpgsql STABLE
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  c        campaign.campaigns%ROWTYPE;
  cv       campaign.campaign_content_versions%ROWTYPE;
  v_body   text;
  v_issues text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO c FROM campaign.campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN RETURN ARRAY['campaign_not_found']; END IF;

  IF c.current_version_id IS NULL THEN
    RETURN ARRAY['no_content_version'];
  END IF;
  SELECT * INTO cv FROM campaign.campaign_content_versions WHERE id = c.current_version_id;

  v_body := lower(COALESCE(cv.body_html_template, '') || ' ' || COALESCE(cv.body_text_template, ''));

  IF position('{{unsubscribe_url}}' IN lower(COALESCE(cv.body_html_template, '') || COALESCE(cv.body_text_template, ''))) = 0
     AND position('unsubscribe' IN v_body) = 0 THEN
    v_issues := v_issues || 'missing_unsubscribe'::text;
  END IF;

  IF position('{{postal_address}}' IN v_body) = 0
     AND NOT EXISTS (
       SELECT 1 FROM campaign.compliance_settings s
       WHERE s.id = true AND btrim(COALESCE(s.postal_address, '')) <> ''
         AND position(lower(left(s.postal_address, 20)) IN v_body) > 0
     ) THEN
    v_issues := v_issues || 'missing_postal_address'::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM campaign.campaign_schedules WHERE campaign_id = p_campaign_id) THEN
    v_issues := v_issues || 'missing_schedule'::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM campaign.campaign_recipients WHERE campaign_id = p_campaign_id) THEN
    v_issues := v_issues || 'no_recipients'::text;
  END IF;

  RETURN v_issues;
END;
$$;


-- ---------------------------------------------------------------------------
-- Approval. Binds the campaign to the exact content hash it was approved with.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.approve_campaign(
  p_campaign_id uuid,
  p_note        text DEFAULT NULL
)
RETURNS campaign.campaign_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  c        campaign.campaigns%ROWTYPE;
  cv       campaign.campaign_content_versions%ROWTYPE;
  v_issues text[];
BEGIN
  SELECT * INTO c FROM campaign.campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign % not found', p_campaign_id USING ERRCODE = 'no_data_found';
  END IF;
  IF c.status NOT IN ('draft', 'pending_approval') THEN
    RAISE EXCEPTION 'campaign % is %, only draft or pending_approval campaigns can be approved',
      p_campaign_id, c.status USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_issues := campaign.compliance_problems(p_campaign_id);
  IF array_length(v_issues, 1) > 0 THEN
    RAISE EXCEPTION 'campaign % fails compliance checks: %', p_campaign_id, array_to_string(v_issues, ', ')
      USING ERRCODE = 'check_violation',
            HINT = 'Every campaign needs an unsubscribe link, a postal address, a schedule, and recipients.';
  END IF;

  SELECT * INTO cv FROM campaign.campaign_content_versions WHERE id = c.current_version_id;

  UPDATE campaign.campaigns
     SET status = 'approved',
         approved_at = now(),
         approved_by = campaign.current_user_id(),
         approved_content_hash = cv.content_hash,
         approval_note = p_note
   WHERE id = p_campaign_id;

  PERFORM campaign.write_audit(
    p_action => 'campaign.approved', p_entity_type => 'campaign',
    p_entity_id => p_campaign_id::text, p_campaign_id => p_campaign_id,
    p_before => jsonb_build_object('status', c.status),
    p_after  => jsonb_build_object('status', 'approved', 'content_hash', cv.content_hash,
                                   'content_version', cv.version),
    p_metadata => jsonb_build_object('note', p_note));

  RETURN 'approved';
END;
$$;

-- ---------------------------------------------------------------------------
-- Any content change invalidates approval and cancels everything not yet sent.
-- This is what makes authorization check #4 meaningful.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.set_campaign_content(
  p_campaign_id uuid,
  p_subject     text,
  p_body_html   text,
  p_body_text   text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  c            campaign.campaigns%ROWTYPE;
  v_version_id uuid;
  v_new_hash   text;
  v_cancelled  integer := 0;
BEGIN
  SELECT * INTO c FROM campaign.campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign % not found', p_campaign_id USING ERRCODE = 'no_data_found';
  END IF;
  IF c.status IN ('stopped', 'completed', 'archived') THEN
    RAISE EXCEPTION 'campaign % is %, its content can no longer change', p_campaign_id, c.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_new_hash := campaign.content_hash(p_subject, p_body_html, p_body_text);

  INSERT INTO campaign.campaign_content_versions
    (campaign_id, subject_template, body_html_template, body_text_template, content_hash, created_by)
  VALUES (p_campaign_id, p_subject, p_body_html, p_body_text, v_new_hash, campaign.current_user_id())
  RETURNING id INTO v_version_id;

  UPDATE campaign.campaigns SET current_version_id = v_version_id WHERE id = p_campaign_id;

  -- If the content actually changed after approval, the approval no longer
  -- describes what would be sent. Revoke it and cancel every unsent job.
  IF c.approved_at IS NOT NULL AND c.approved_content_hash IS DISTINCT FROM v_new_hash THEN
    UPDATE campaign.campaigns
       SET status = 'pending_approval',
           approved_at = NULL, approved_by = NULL,
           approved_content_hash = NULL, approval_note = NULL
     WHERE id = p_campaign_id;

    WITH cancelled AS (
      UPDATE campaign.email_jobs
         SET status = 'cancelled', skip_reason = 'content_changed_since_approval',
             locked_by = NULL, locked_at = NULL, lease_expires_at = NULL
       WHERE campaign_id = p_campaign_id
         AND status IN ('pending', 'queued', 'held', 'failed_retryable')
      RETURNING 1
    )
    SELECT count(*) INTO v_cancelled FROM cancelled;

    PERFORM campaign.write_audit(
      p_action => 'campaign.approval_revoked', p_entity_type => 'campaign',
      p_entity_id => p_campaign_id::text, p_campaign_id => p_campaign_id,
      p_reason_code => 'content_changed_since_approval',
      p_before => jsonb_build_object('approved_content_hash', c.approved_content_hash),
      p_after  => jsonb_build_object('content_hash', v_new_hash, 'jobs_cancelled', v_cancelled));
  END IF;

  PERFORM campaign.write_audit(
    p_action => 'campaign.content_updated', p_entity_type => 'campaign',
    p_entity_id => p_campaign_id::text, p_campaign_id => p_campaign_id,
    p_after => jsonb_build_object('content_version_id', v_version_id, 'content_hash', v_new_hash));

  RETURN v_version_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Start / pause / resume / stop
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.start_campaign(p_campaign_id uuid)
RETURNS campaign.campaign_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  c campaign.campaigns%ROWTYPE;
  v_released integer;
BEGIN
  SELECT * INTO c FROM campaign.campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign % not found', p_campaign_id USING ERRCODE = 'no_data_found';
  END IF;
  IF c.status NOT IN ('approved', 'scheduled', 'paused') THEN
    RAISE EXCEPTION 'campaign % is %, only approved, scheduled or paused campaigns can be started',
      p_campaign_id, c.status USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF c.approved_at IS NULL THEN
    RAISE EXCEPTION 'campaign % is not approved', p_campaign_id USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE campaign.campaigns
     SET status = 'running',
         started_at = COALESCE(started_at, now()),
         paused_reason = NULL, paused_at = NULL, paused_by = NULL,
         consecutive_failures = 0
   WHERE id = p_campaign_id;

  -- Release materialized jobs into the queue. Suppressed and cancelled jobs
  -- stay where they are.
  WITH released AS (
    UPDATE campaign.email_jobs
       SET status = 'queued', available_at = now(), skip_reason = NULL
     WHERE campaign_id = p_campaign_id AND status = 'pending'
    RETURNING 1
  )
  SELECT count(*) INTO v_released FROM released;

  PERFORM campaign.write_audit(
    p_action => 'campaign.started', p_entity_type => 'campaign',
    p_entity_id => p_campaign_id::text, p_campaign_id => p_campaign_id,
    p_before => jsonb_build_object('status', c.status),
    p_after  => jsonb_build_object('status', 'running', 'jobs_released', v_released));

  RETURN 'running';
END;
$$;

CREATE OR REPLACE FUNCTION campaign.pause_campaign(p_campaign_id uuid, p_reason text DEFAULT NULL)
RETURNS campaign.campaign_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  c campaign.campaigns%ROWTYPE;
BEGIN
  SELECT * INTO c FROM campaign.campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign % not found', p_campaign_id USING ERRCODE = 'no_data_found';
  END IF;
  IF c.status <> 'running' THEN
    RAISE EXCEPTION 'campaign % is %, only a running campaign can be paused', p_campaign_id, c.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Note: queued jobs are deliberately NOT rewritten. Authorization refuses
  -- them while the campaign is paused, so pausing is instant and resuming
  -- cannot lose or mis-restore rows.
  UPDATE campaign.campaigns
     SET status = 'paused', paused_reason = p_reason, paused_at = now(),
         paused_by = campaign.current_user_id()
   WHERE id = p_campaign_id;

  PERFORM campaign.write_audit(
    p_action => 'campaign.paused', p_entity_type => 'campaign',
    p_entity_id => p_campaign_id::text, p_campaign_id => p_campaign_id,
    p_reason_code => 'operator_paused',
    p_metadata => jsonb_build_object('reason', p_reason));

  RETURN 'paused';
END;
$$;

CREATE OR REPLACE FUNCTION campaign.resume_campaign(p_campaign_id uuid)
RETURNS campaign.campaign_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  c campaign.campaigns%ROWTYPE;
BEGIN
  SELECT * INTO c FROM campaign.campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign % not found', p_campaign_id USING ERRCODE = 'no_data_found';
  END IF;
  IF c.status <> 'paused' THEN
    RAISE EXCEPTION 'campaign % is %, not paused', p_campaign_id, c.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF c.approved_at IS NULL THEN
    RAISE EXCEPTION 'campaign % lost its approval and cannot resume until re-approved', p_campaign_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE campaign.campaigns
     SET status = 'running', paused_reason = NULL, paused_at = NULL, paused_by = NULL,
         consecutive_failures = 0
   WHERE id = p_campaign_id;

  -- Clear the parking imposed while paused so work resumes immediately.
  UPDATE campaign.email_jobs
     SET available_at = now(), skip_reason = NULL
   WHERE campaign_id = p_campaign_id
     AND status = 'queued'
     AND skip_reason = 'campaign_paused';

  PERFORM campaign.write_audit(
    p_action => 'campaign.resumed', p_entity_type => 'campaign',
    p_entity_id => p_campaign_id::text, p_campaign_id => p_campaign_id);

  RETURN 'running';
END;
$$;

CREATE OR REPLACE FUNCTION campaign.stop_campaign(p_campaign_id uuid, p_reason text DEFAULT NULL)
RETURNS campaign.campaign_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  c           campaign.campaigns%ROWTYPE;
  v_cancelled integer;
BEGIN
  SELECT * INTO c FROM campaign.campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign % not found', p_campaign_id USING ERRCODE = 'no_data_found';
  END IF;
  IF c.status IN ('stopped', 'completed', 'archived') THEN
    RETURN c.status;
  END IF;

  UPDATE campaign.campaigns
     SET status = 'stopped', stopped_reason = p_reason, stopped_at = now(),
         stopped_by = campaign.current_user_id()
   WHERE id = p_campaign_id;

  -- Stopping is final: everything not already sent or in flight is cancelled.
  -- Jobs in 'sending' are left alone -- their outcome is still being determined
  -- and cancelling them would lose the record of a real send.
  WITH cancelled AS (
    UPDATE campaign.email_jobs
       SET status = 'cancelled', skip_reason = 'campaign_stopped',
           locked_by = NULL, locked_at = NULL, lease_expires_at = NULL
     WHERE campaign_id = p_campaign_id
       AND status IN ('pending', 'queued', 'held', 'failed_retryable', 'claimed', 'suppressed')
    RETURNING 1
  )
  SELECT count(*) INTO v_cancelled FROM cancelled;

  PERFORM campaign.write_audit(
    p_action => 'campaign.stopped', p_entity_type => 'campaign',
    p_entity_id => p_campaign_id::text, p_campaign_id => p_campaign_id,
    p_reason_code => 'operator_stopped',
    p_metadata => jsonb_build_object('reason', p_reason, 'jobs_cancelled', v_cancelled));

  RETURN 'stopped';
END;
$$;

-- ---------------------------------------------------------------------------
-- Global emergency stop. Instant, global, and audited. Nothing is claimed while
-- it is engaged, and any in-flight pre-flight check refuses.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.set_emergency_stop(p_engaged boolean, p_reason text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  ctl campaign.system_controls%ROWTYPE;
BEGIN
  IF p_engaged AND (p_reason IS NULL OR btrim(p_reason) = '') THEN
    RAISE EXCEPTION 'a reason is required to engage the emergency stop'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO ctl FROM campaign.system_controls WHERE id = true FOR UPDATE;

  UPDATE campaign.system_controls
     SET emergency_stop = p_engaged,
         emergency_stop_reason = CASE WHEN p_engaged THEN p_reason ELSE NULL END,
         emergency_stop_by = CASE WHEN p_engaged THEN campaign.current_user_id() ELSE NULL END,
         emergency_stop_at = CASE WHEN p_engaged THEN now() ELSE NULL END,
         updated_at = now(), updated_by = campaign.current_user_id()
   WHERE id = true;

  PERFORM campaign.write_audit(
    p_action => CASE WHEN p_engaged THEN 'system.emergency_stop_engaged'
                     ELSE 'system.emergency_stop_released' END,
    p_entity_type => 'system_controls', p_entity_id => 'singleton',
    p_reason_code => CASE WHEN p_engaged THEN 'emergency_stop_engaged' ELSE 'emergency_stop_released' END,
    p_before => jsonb_build_object('emergency_stop', ctl.emergency_stop),
    p_after  => jsonb_build_object('emergency_stop', p_engaged),
    p_metadata => jsonb_build_object('reason', p_reason));

  IF p_engaged THEN
    PERFORM campaign.raise_alert('emergency_stop', 'critical', 'EMERGENCY STOP ENGAGED',
      COALESCE(p_reason, 'No reason given'), NULL, NULL, NULL);
  ELSE
    PERFORM campaign.resolve_alert('emergency_stop');
  END IF;

  RETURN p_engaged;
END;
$$;

CREATE OR REPLACE FUNCTION campaign.set_production_mode(p_enabled boolean, p_reason text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  ctl campaign.system_controls%ROWTYPE;
BEGIN
  SELECT * INTO ctl FROM campaign.system_controls WHERE id = true FOR UPDATE;

  UPDATE campaign.system_controls
     SET production_mode = p_enabled,
         production_mode_by = campaign.current_user_id(),
         production_mode_at = now(),
         updated_at = now(), updated_by = campaign.current_user_id()
   WHERE id = true;

  PERFORM campaign.write_audit(
    p_action => CASE WHEN p_enabled THEN 'system.production_mode_enabled'
                     ELSE 'system.production_mode_disabled' END,
    p_entity_type => 'system_controls', p_entity_id => 'singleton',
    p_before => jsonb_build_object('production_mode', ctl.production_mode),
    p_after  => jsonb_build_object('production_mode', p_enabled),
    p_metadata => jsonb_build_object('reason', p_reason));

  RETURN p_enabled;
END;
$$;

CREATE OR REPLACE FUNCTION campaign.set_sender_status(
  p_sender_id uuid, p_status campaign.sender_status, p_reason text DEFAULT NULL
)
RETURNS campaign.sender_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  s campaign.sender_accounts%ROWTYPE;
BEGIN
  SELECT * INTO s FROM campaign.sender_accounts WHERE id = p_sender_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sender % not found', p_sender_id USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE campaign.sender_accounts
     SET status = p_status,
         paused_reason = CASE WHEN p_status = 'active' THEN NULL ELSE p_reason END,
         paused_at     = CASE WHEN p_status = 'active' THEN NULL ELSE now() END,
         paused_by     = CASE WHEN p_status = 'active' THEN NULL ELSE campaign.current_user_id() END
   WHERE id = p_sender_id;

  IF p_status = 'active' THEN
    -- Un-park jobs that were waiting on this mailbox.
    UPDATE campaign.email_jobs
       SET available_at = now(), skip_reason = NULL
     WHERE sender_account_id = p_sender_id
       AND status = 'queued'
       AND skip_reason IN ('sender_paused', 'sender_disabled');
    PERFORM campaign.resolve_alert('sender_auth_failure.' || p_sender_id::text);
  END IF;

  PERFORM campaign.write_audit(
    p_action => 'sender.status_changed', p_entity_type => 'sender_account',
    p_entity_id => p_sender_id::text,
    p_before => jsonb_build_object('status', s.status),
    p_after  => jsonb_build_object('status', p_status),
    p_metadata => jsonb_build_object('reason', p_reason));

  RETURN p_status;
END;
$$;
