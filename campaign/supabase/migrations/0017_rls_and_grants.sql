-- =============================================================================
-- 0017  Row level security, roles, and grants
-- =============================================================================
-- Two very different principals use this schema:
--
--   * the ADMIN UI, as an authenticated end user, through PostgREST/Supabase.
--     Everything it can do is bounded by RLS policies keyed on app_profiles.role.
--
--   * the WORKER, with the service role. It is powerful, so it is fenced in a
--     different way: direct UPDATE on email_jobs is REVOKED, leaving the
--     authorization functions as its only route to a sendable email.
--
-- Supabase creates the anon/authenticated/service_role roles; a plain cluster
-- does not, so we create any that are missing to keep these migrations
-- portable.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  -- Least-privileged role for n8n: it may observe, and it may nudge. It may not
  -- change a single thing about whether an email sends.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campaign_readonly') THEN
    CREATE ROLE campaign_readonly NOLOGIN NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA campaign TO anon, authenticated, service_role, campaign_readonly;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. A table without a policy is then closed by default,
-- which is the failure mode we want.
-- ---------------------------------------------------------------------------
ALTER TABLE campaign.app_profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.system_controls           ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.compliance_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.sender_accounts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.test_recipients           ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.contacts                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.contact_lists             ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.contact_list_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.import_batches            ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.import_errors             ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.suppressions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.campaigns                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.campaign_content_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.campaign_schedules        ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.campaign_recipients       ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.email_jobs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.email_job_attempts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.send_counters             ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.audit_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.alerts                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign.allowed_transitions       ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Read access: any signed-in operator (viewer and above) may read operational
-- data. Contacts carry PII, so viewers can read but never export-by-write.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sender_accounts','test_recipients','contacts','contact_lists','contact_list_members',
    'import_batches','import_errors','suppressions','campaigns','campaign_content_versions',
    'campaign_schedules','campaign_recipients','email_jobs','email_job_attempts',
    'send_counters','audit_events','alerts','allowed_transitions','system_controls',
    'compliance_settings'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I_read ON campaign.%I FOR SELECT TO authenticated USING (campaign.has_role(''viewer''))',
      t, t);
  END LOOP;
END
$$;

-- Everyone may read their own profile; owners may read all of them.
CREATE POLICY app_profiles_read ON campaign.app_profiles
  FOR SELECT TO authenticated
  USING (id = campaign.current_user_id() OR campaign.has_role('owner'));

CREATE POLICY app_profiles_owner_write ON campaign.app_profiles
  FOR ALL TO authenticated
  USING (campaign.has_role('owner'))
  WITH CHECK (campaign.has_role('owner'));

-- ---------------------------------------------------------------------------
-- Write access for operators (build campaigns, manage contacts).
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'contacts','contact_lists','contact_list_members','import_batches','import_errors',
    'campaigns','campaign_content_versions','campaign_schedules','campaign_recipients'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I_operator_write ON campaign.%I FOR ALL TO authenticated '
      'USING (campaign.has_role(''operator'')) WITH CHECK (campaign.has_role(''operator''))',
      t, t);
  END LOOP;
END
$$;

-- Sender accounts and the test allowlist are configuration, not content:
-- owner only.
CREATE POLICY sender_accounts_owner_write ON campaign.sender_accounts
  FOR ALL TO authenticated
  USING (campaign.has_role('owner')) WITH CHECK (campaign.has_role('owner'));

CREATE POLICY test_recipients_owner_write ON campaign.test_recipients
  FOR ALL TO authenticated
  USING (campaign.has_role('owner')) WITH CHECK (campaign.has_role('owner'));

CREATE POLICY compliance_settings_owner_write ON campaign.compliance_settings
  FOR UPDATE TO authenticated
  USING (campaign.has_role('owner')) WITH CHECK (campaign.has_role('owner'));

-- Suppressions may be ADDED by an operator but never deleted by anyone: the
-- table is append-only, and revocation is an UPDATE guarded by a function.
CREATE POLICY suppressions_operator_insert ON campaign.suppressions
  FOR INSERT TO authenticated WITH CHECK (campaign.has_role('operator'));

-- Alerts: an operator may acknowledge or resolve, but never create or delete
-- one. Alerts are raised by the system as a record of what happened.
CREATE POLICY alerts_operator_update ON campaign.alerts
  FOR UPDATE TO authenticated
  USING (campaign.has_role('operator')) WITH CHECK (campaign.has_role('operator'));

-- The notifier role may read every alert and stamp notified_at. Grants alone
-- are not enough once RLS is enabled: without a policy the reads silently
-- return nothing and the update silently touches no rows.
CREATE POLICY alerts_notifier_select ON campaign.alerts
  FOR SELECT TO campaign_readonly USING (true);

CREATE POLICY alerts_notifier_update ON campaign.alerts
  FOR UPDATE TO campaign_readonly USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Deliberately NOT granted to the UI:
--   * UPDATE/DELETE on email_jobs        -- state changes go through functions
--   * INSERT on email_jobs               -- jobs come from materialization only
--   * anything at all on send_counters   -- counters are derived facts
--   * UPDATE/DELETE on audit_events      -- append-only
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Table-level privileges
-- ---------------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA campaign TO authenticated;
GRANT INSERT, UPDATE, DELETE ON
  campaign.contacts, campaign.contact_lists, campaign.contact_list_members,
  campaign.import_batches, campaign.import_errors,
  campaign.campaigns, campaign.campaign_content_versions,
  campaign.campaign_schedules, campaign.campaign_recipients
TO authenticated;
GRANT INSERT ON campaign.suppressions TO authenticated;
GRANT UPDATE ON campaign.app_profiles, campaign.compliance_settings TO authenticated;
-- Owner-only configuration. The RLS policies above decide WHO; these grants
-- are what let the statement reach RLS at all.
GRANT INSERT, UPDATE, DELETE ON campaign.sender_accounts, campaign.test_recipients TO authenticated;
-- Acknowledging and resolving an alert is an operator action.
GRANT UPDATE ON campaign.alerts TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA campaign TO authenticated;

-- The audit trail is append-only for EVERY role, service_role included.
REVOKE UPDATE, DELETE, TRUNCATE ON campaign.audit_events FROM authenticated, anon, service_role, campaign_readonly;

-- The worker's fence. It holds the service role, but its only route to a
-- sendable email is campaign.claim_email_jobs(); it cannot hand itself one.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON campaign.email_jobs FROM authenticated, anon, campaign_readonly;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON campaign.send_counters FROM authenticated, anon, campaign_readonly;

-- n8n: observe and nothing more.
GRANT SELECT ON campaign.alerts, campaign.queue_health, campaign.campaign_progress,
                campaign.sender_capacity
TO campaign_readonly;
-- Marking an alert as notified is the single write n8n needs.
GRANT UPDATE (notified_at) ON campaign.alerts TO campaign_readonly;
REVOKE ALL ON campaign.email_jobs, campaign.contacts, campaign.campaigns,
             campaign.system_controls, campaign.suppressions
FROM campaign_readonly;

-- ---------------------------------------------------------------------------
-- Function privileges.
--
-- An allowlist here proved to be the wrong shape. CHECK constraints, generated
-- columns and triggers all execute functions AS THE CALLING USER, so a blanket
-- revoke silently breaks ordinary inserts with "permission denied for function
-- ..." -- and the list of functions a constraint might reach is not something a
-- reviewer can reliably keep in their head.
--
-- So the model is inverted: the control plane may execute anything in this
-- schema EXCEPT the execution-plane functions, which are enumerated explicitly
-- below. That list is short, security-relevant, and obvious to review -- and
-- adding a new helper function can no longer break inserts by omission.
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA campaign FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA campaign TO authenticated;

-- The execution plane. Only the worker may call these: they are what turns a
-- database row into an email leaving the building.
REVOKE EXECUTE ON FUNCTION
  campaign.claim_email_jobs(text, integer, integer, uuid),
  campaign.mark_sending(uuid, text),
  campaign.mark_sent(uuid, text, text, text, integer, text),
  campaign.mark_failed(uuid, text, campaign.failure_class, text, text, integer, text, integer),
  campaign.reap_expired_leases(timestamptz),
  campaign.release_worker_leases(text),
  campaign.resolve_reconciliation(uuid, boolean, text, text, text, text),
  campaign.send_denial_reason_for_inflight(uuid),
  campaign.apply_denial(uuid, text, timestamptz)
FROM authenticated;

GRANT EXECUTE ON FUNCTION
  campaign.claim_email_jobs(text, integer, integer, uuid),
  campaign.mark_sending(uuid, text),
  campaign.mark_sent(uuid, text, text, text, integer, text),
  campaign.mark_failed(uuid, text, campaign.failure_class, text, text, integer, text, integer),
  campaign.reap_expired_leases(timestamptz),
  campaign.release_worker_leases(text),
  campaign.resolve_reconciliation(uuid, boolean, text, text, text, text),
  campaign.send_denial_reason_for_inflight(uuid),
  campaign.apply_denial(uuid, text, timestamptz)
TO service_role;

-- The unsubscribe endpoint runs unauthenticated, so it gets exactly one
-- function and no table access at all.
CREATE OR REPLACE FUNCTION campaign.public_unsubscribe(
  p_email       text,
  p_campaign_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
BEGIN
  PERFORM campaign.add_suppression(
    p_email, 'unsubscribe', 'global', NULL, 'unsubscribe_link',
    CASE WHEN p_campaign_id IS NOT NULL
         THEN format('One-click unsubscribe from campaign %s', p_campaign_id) END);
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION campaign.public_unsubscribe(text, uuid) TO anon, authenticated, service_role;

-- View security is split deliberately by what each view exposes.
--
-- job_monitor returns individual recipients, subjects and rendered bodies, so
-- it runs as the INVOKER: the reader needs their own privileges on email_jobs,
-- and RLS applies row by row.
ALTER VIEW campaign.job_monitor SET (security_invoker = on);

-- The rollups expose only counts, campaign names and mailbox addresses -- no
-- recipient data at all. They run as the view owner so an observer (n8n's
-- read-only role, or a viewer) can read operational health without being
-- granted access to the underlying contact and job tables.
ALTER VIEW campaign.campaign_progress SET (security_invoker = off);
ALTER VIEW campaign.queue_health      SET (security_invoker = off);
ALTER VIEW campaign.sender_capacity   SET (security_invoker = off);

GRANT SELECT ON campaign.job_monitor, campaign.campaign_progress,
                campaign.queue_health, campaign.sender_capacity
TO authenticated;
