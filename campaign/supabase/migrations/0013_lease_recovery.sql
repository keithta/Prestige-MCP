-- =============================================================================
-- 0013  Lease recovery and reconciliation
-- =============================================================================
-- What happens when a worker dies mid-flight. This is where the duplicate-send
-- bug would live if we got it wrong, so the rule is absolute:
--
--   a job that was CLAIMED (no request made yet) may safely return to the queue
--   a job that was SENDING (request may have been delivered) may NOT.
--
-- The second case goes to needs_reconciliation and is resolved by looking for
-- the message in Sent Items -- by evidence, never by assumption.
-- =============================================================================

CREATE OR REPLACE FUNCTION campaign.reap_expired_leases(p_at timestamptz DEFAULT now())
RETURNS TABLE (released integer, reconciling integer, retried integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  v_released    integer := 0;
  v_reconciling integer := 0;
  v_retried     integer := 0;
  r             record;
BEGIN
  -- Claimed but never sent: nothing left our process, so it is safe to requeue.
  FOR r IN
    SELECT id FROM campaign.email_jobs
    WHERE status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at < p_at
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE campaign.email_jobs
       SET status = 'queued', locked_by = NULL, locked_at = NULL,
           lease_expires_at = NULL, skip_reason = 'lease_expired_released'
     WHERE id = r.id;
    v_released := v_released + 1;
  END LOOP;

  -- In flight when the worker vanished. We do NOT know whether Microsoft
  -- accepted the message, so this must never go back to the queue.
  FOR r IN
    SELECT id, campaign_id, sender_account_id, recipient_email
    FROM campaign.email_jobs
    WHERE status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at < p_at
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE campaign.email_jobs
       SET status = 'needs_reconciliation',
           locked_by = NULL, locked_at = NULL, lease_expires_at = NULL,
           skip_reason = 'lease_expired_while_sending'
     WHERE id = r.id;
    v_reconciling := v_reconciling + 1;

    PERFORM campaign.raise_alert(
      'needs_reconciliation.' || r.campaign_id::text, 'critical',
      'Send outcome unknown after worker loss',
      format('Job %s to %s was in flight when its lease expired. It will NOT be retried until reconciled against Sent Items.',
             r.id, r.recipient_email),
      r.campaign_id, r.sender_account_id, r.id);
  END LOOP;

  -- Safety net: a retry whose backoff elapsed but which never made it back to
  -- the queue (e.g. a crash between the two transitions in mark_failed).
  FOR r IN
    SELECT id FROM campaign.email_jobs
    WHERE status = 'failed_retryable' AND available_at <= p_at
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE campaign.email_jobs
       SET status = 'queued', skip_reason = 'awaiting_retry'
     WHERE id = r.id;
    v_retried := v_retried + 1;
  END LOOP;

  IF v_released > 0 OR v_reconciling > 0 OR v_retried > 0 THEN
    PERFORM campaign.write_audit(
      p_action => 'lease.reaped', p_actor_type => 'system',
      p_metadata => jsonb_build_object('released', v_released,
                                       'reconciling', v_reconciling,
                                       'retried', v_retried));
  END IF;

  RETURN QUERY SELECT v_released, v_reconciling, v_retried;
END;
$$;

-- ---------------------------------------------------------------------------
-- Graceful shutdown: a worker hands back leases it has not started sending.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.release_worker_leases(p_worker_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  v_count integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT id FROM campaign.email_jobs
    WHERE status = 'claimed' AND locked_by = p_worker_id
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE campaign.email_jobs
       SET status = 'queued', locked_by = NULL, locked_at = NULL,
           lease_expires_at = NULL, skip_reason = 'released_on_shutdown'
     WHERE id = r.id;
    v_count := v_count + 1;
  END LOOP;

  IF v_count > 0 THEN
    PERFORM campaign.write_audit(
      p_action => 'lease.released_on_shutdown', p_actor_type => 'worker',
      p_actor_label => p_worker_id,
      p_metadata => jsonb_build_object('released', v_count));
  END IF;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Reconciliation outcome. p_was_sent must come from EVIDENCE: the message was
-- found in Sent Items carrying this job's x-campaign-job-id header.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.resolve_reconciliation(
  p_job_id           uuid,
  p_was_sent         boolean,
  p_worker_id        text,
  p_evidence         text DEFAULT NULL,
  p_graph_message_id text DEFAULT NULL,
  p_internet_message_id text DEFAULT NULL
)
RETURNS campaign.job_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  j campaign.email_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM campaign.email_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job % not found', p_job_id USING ERRCODE = 'no_data_found';
  END IF;
  IF j.status <> 'needs_reconciliation' THEN
    RAISE EXCEPTION 'job % is %, not awaiting reconciliation', p_job_id, j.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM campaign.write_audit(
    p_action => 'reconciliation.resolved', p_entity_type => 'email_job',
    p_entity_id => p_job_id::text, p_campaign_id => j.campaign_id, p_job_id => p_job_id,
    p_actor_type => 'worker', p_actor_label => p_worker_id,
    p_reason_code => CASE WHEN p_was_sent THEN 'confirmed_sent' ELSE 'confirmed_not_sent' END,
    p_metadata => jsonb_build_object('evidence', p_evidence));

  IF p_was_sent THEN
    -- Record the send. mark_sent handles the counter and the attempt row.
    PERFORM campaign.mark_sent(p_job_id, p_worker_id, p_graph_message_id, p_internet_message_id);
    PERFORM campaign.resolve_alert('needs_reconciliation.' || j.campaign_id::text);
    RETURN 'sent';
  END IF;

  -- Confirmed NOT delivered: it is now safe to retry.
  UPDATE campaign.email_jobs
     SET status = 'queued',
         available_at = now() + interval '30 seconds',
         skip_reason = 'reconciled_not_sent'
   WHERE id = p_job_id;

  PERFORM campaign.resolve_alert('needs_reconciliation.' || j.campaign_id::text);
  RETURN 'queued';
END;
$$;

CREATE OR REPLACE FUNCTION campaign.resolve_alert(p_alert_key text)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
  WITH upd AS (
    UPDATE campaign.alerts SET resolved_at = now()
    WHERE alert_key = p_alert_key AND resolved_at IS NULL
    RETURNING 1
  )
  SELECT COALESCE(count(*), 0)::integer FROM upd;
$$;

-- ---------------------------------------------------------------------------
-- Operator-initiated requeue of a permanently failed or skipped job.
-- Deliberately explicit and audited: this is a human overriding the system.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.requeue_job(p_job_id uuid, p_reason text)
RETURNS campaign.job_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  j campaign.email_jobs%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'a reason is required to requeue a job' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO j FROM campaign.email_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job % not found', p_job_id USING ERRCODE = 'no_data_found';
  END IF;
  IF j.status NOT IN ('failed_permanent', 'skipped', 'held') THEN
    RAISE EXCEPTION 'job % is %, only failed_permanent, skipped or held jobs may be requeued', p_job_id, j.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Requeueing resets the attempt budget; otherwise it would fail immediately
  -- on the attempts_exhausted check.
  UPDATE campaign.email_jobs
     SET status = 'queued', attempt_count = 0, available_at = now(),
         skip_reason = 'operator_requeued', last_error_code = NULL, last_error_message = NULL
   WHERE id = p_job_id;

  PERFORM campaign.write_audit(
    p_action => 'email_job.requeued', p_entity_type => 'email_job',
    p_entity_id => p_job_id::text, p_campaign_id => j.campaign_id, p_job_id => p_job_id,
    p_reason_code => 'operator_requeued',
    p_metadata => jsonb_build_object('reason', p_reason, 'previous_status', j.status));

  RETURN 'queued';
END;
$$;
