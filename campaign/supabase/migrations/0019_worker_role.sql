-- =============================================================================
-- 0019  A least-privilege role for the sending worker
-- =============================================================================
-- The architecture claims the worker's only route to a sendable email is
-- claim_email_jobs(). Until now that was a convention in the worker's own code
-- rather than something the database enforced: the worker connects directly
-- with DATABASE_URL, so it inherited whatever that user could do -- usually
-- everything.
--
-- This role makes the claim true. It can execute the nine execution-plane
-- functions and read what it needs to build a message. It cannot INSERT,
-- UPDATE or DELETE a single row in any table, so it cannot hand itself work,
-- cannot rewrite a job's state, and cannot alter a counter.
--
-- Point the worker's DATABASE_URL at this role in production. See
-- docs/DEPLOY.md.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campaign_worker') THEN
    CREATE ROLE campaign_worker NOLOGIN NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA campaign TO campaign_worker;

-- -----------------------------------------------------------------------------
-- The one write the worker used to make directly. Persisting the draft id
-- BEFORE the send is what makes an ambiguous outcome recoverable, so it has to
-- happen -- but it does not justify a blanket UPDATE grant on email_jobs.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.record_graph_draft_id(
  p_job_id   uuid,
  p_draft_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
BEGIN
  IF p_draft_id IS NULL OR btrim(p_draft_id) = '' THEN
    RAISE EXCEPTION 'a draft id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Only while the job is actually being worked on, and only if it does not
  -- already carry one: a draft id is write-once per attempt.
  UPDATE campaign.email_jobs
     SET graph_draft_id = p_draft_id
   WHERE id = p_job_id
     AND status IN ('claimed', 'sending');
END;
$$;

-- Reading the jobs awaiting reconciliation, without granting table access.
CREATE OR REPLACE FUNCTION campaign.jobs_needing_reconciliation(p_limit integer DEFAULT 25)
RETURNS SETOF campaign.email_jobs
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
  SELECT * FROM campaign.email_jobs
   WHERE status = 'needs_reconciliation'
   ORDER BY updated_at
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 500);
$$;

-- The mailbox and footer details needed to build a message.
CREATE OR REPLACE FUNCTION campaign.sender_for_job(p_job_id uuid)
RETURNS TABLE (
  mailbox_address text,
  min_interval_seconds integer,
  tenant_id text,
  reply_to text,
  app_base_url text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
  SELECT s.mailbox_address::text,
         s.min_interval_seconds,
         s.tenant_id,
         (SELECT c.reply_to::text FROM campaign.compliance_settings c WHERE c.id),
         (SELECT c.app_base_url    FROM campaign.compliance_settings c WHERE c.id)
    FROM campaign.email_jobs j
    JOIN campaign.sender_accounts s ON s.id = j.sender_account_id
   WHERE j.id = p_job_id;
$$;

-- -----------------------------------------------------------------------------
-- Exactly what the worker may do. Nothing else.
-- -----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION
  campaign.claim_email_jobs(text, integer, integer, uuid),
  campaign.mark_sending(uuid, text),
  campaign.mark_sent(uuid, text, text, text, integer, text),
  campaign.mark_failed(uuid, text, campaign.failure_class, text, text, integer, text, integer),
  campaign.reap_expired_leases(timestamptz),
  campaign.release_worker_leases(text),
  campaign.resolve_reconciliation(uuid, boolean, text, text, text, text),
  campaign.record_graph_draft_id(uuid, text),
  campaign.jobs_needing_reconciliation(integer),
  campaign.sender_for_job(uuid)
TO campaign_worker;

-- Operational health, for /health and /metrics. A rollup only: no recipients.
GRANT SELECT ON campaign.queue_health TO campaign_worker;

-- Not granted, deliberately: INSERT, UPDATE or DELETE on ANY table. The worker
-- cannot create a job, change a job's state outside the lifecycle functions,
-- move a counter, write an audit row directly, or touch the global controls.
REVOKE ALL ON ALL TABLES IN SCHEMA campaign FROM campaign_worker;
GRANT SELECT ON campaign.queue_health TO campaign_worker;

COMMENT ON FUNCTION campaign.record_graph_draft_id(uuid, text) IS
  'Records the Graph draft id before a send is attempted. Exists so the worker needs no direct UPDATE privilege on email_jobs.';
