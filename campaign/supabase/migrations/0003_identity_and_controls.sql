-- =============================================================================
-- 0003  Operators, global controls, sender accounts, test allowlist
-- =============================================================================

-- -----------------------------------------------------------------------------
-- app_profiles : who may operate the system, and at what level.
-- On Supabase, id matches auth.users.id. We deliberately do NOT add a foreign
-- key to auth.users so these migrations also apply to a plain Postgres cluster
-- for testing; docs/INSTALL.md covers the Supabase trigger that keeps them in
-- sync.
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.app_profiles (
  id          uuid PRIMARY KEY,
  email       citext NOT NULL UNIQUE,
  full_name   text,
  role        campaign.app_role NOT NULL DEFAULT 'viewer',
  disabled    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER app_profiles_set_updated_at
  BEFORE UPDATE ON campaign.app_profiles
  FOR EACH ROW EXECUTE FUNCTION campaign.set_updated_at();

COMMENT ON TABLE campaign.app_profiles IS
  'Operator accounts. Roles: owner (all, incl. production mode), approver (may approve campaigns), operator (may build/run), viewer (read only).';

-- Role test helpers, used by RLS policies throughout.
CREATE OR REPLACE FUNCTION campaign.current_role_level()
RETURNS campaign.app_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
  SELECT p.role
  FROM campaign.app_profiles p
  WHERE p.id = campaign.current_user_id()
    AND p.disabled = false;
$$;

CREATE OR REPLACE FUNCTION campaign.has_role(p_min campaign.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = campaign, public, pg_temp
AS $$
  -- Ordering is explicit rather than relying on enum order, so reordering the
  -- enum later cannot silently change who is allowed to do what.
  SELECT CASE campaign.current_role_level()
           WHEN 'owner'    THEN 4
           WHEN 'approver' THEN 3
           WHEN 'operator' THEN 2
           WHEN 'viewer'   THEN 1
           ELSE 0
         END
       >= CASE p_min
           WHEN 'owner'    THEN 4
           WHEN 'approver' THEN 3
           WHEN 'operator' THEN 2
           WHEN 'viewer'   THEN 1
           ELSE 0
         END;
$$;

-- -----------------------------------------------------------------------------
-- system_controls : the global kill switches. Exactly one row, forever.
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.system_controls (
  id                     boolean PRIMARY KEY DEFAULT true,
  emergency_stop         boolean NOT NULL DEFAULT false,
  emergency_stop_reason  text,
  emergency_stop_by      uuid,
  emergency_stop_at      timestamptz,
  global_send_enabled    boolean NOT NULL DEFAULT true,
  -- Ships OFF. Production sending requires a deliberate, audited flip.
  production_mode        boolean NOT NULL DEFAULT false,
  production_mode_by     uuid,
  production_mode_at     timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  CONSTRAINT system_controls_singleton CHECK (id = true)
);

INSERT INTO campaign.system_controls (id) VALUES (true);

COMMENT ON TABLE campaign.system_controls IS
  'Singleton row holding the global emergency stop, send enable, and production-mode gate. Checked on every send authorization.';

-- -----------------------------------------------------------------------------
-- sender_accounts : the mailboxes we are permitted to send from.
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.sender_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_address      citext NOT NULL UNIQUE,
  display_name         text,
  -- Entra tenant this mailbox belongs to; verified against the worker's
  -- configured tenant before sending, so a misconfigured worker cannot send
  -- from a mailbox belonging to a different tenant.
  tenant_id            text,
  status               campaign.sender_status NOT NULL DEFAULT 'active',
  daily_limit          integer NOT NULL DEFAULT 500,
  hourly_limit         integer NOT NULL DEFAULT 60,
  min_interval_seconds integer NOT NULL DEFAULT 4,
  timezone             text NOT NULL DEFAULT 'UTC',
  paused_reason        text,
  paused_at            timestamptz,
  paused_by            uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sender_daily_limit_positive  CHECK (daily_limit  > 0 AND daily_limit  <= 100000),
  CONSTRAINT sender_hourly_limit_positive CHECK (hourly_limit > 0 AND hourly_limit <= 10000),
  CONSTRAINT sender_interval_nonneg       CHECK (min_interval_seconds >= 0 AND min_interval_seconds <= 3600),
  CONSTRAINT sender_hourly_le_daily       CHECK (hourly_limit <= daily_limit),
  CONSTRAINT sender_timezone_valid        CHECK (campaign.is_valid_timezone(timezone)),
  CONSTRAINT sender_mailbox_shape         CHECK (mailbox_address ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$')
);

CREATE TRIGGER sender_accounts_set_updated_at
  BEFORE UPDATE ON campaign.sender_accounts
  FOR EACH ROW EXECUTE FUNCTION campaign.set_updated_at();

COMMENT ON COLUMN campaign.sender_accounts.min_interval_seconds IS
  'Minimum gap between sends from this mailbox. Default 4s keeps us at ~15/min, well under Exchange Online throttling.';

-- -----------------------------------------------------------------------------
-- test_recipients : while a campaign is in test mode, these are the ONLY
-- addresses that can be reached. Nothing else can be sent to, at any volume.
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.test_recipients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_canonical citext NOT NULL UNIQUE,
  note            text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE campaign.test_recipients IS
  'Allowlist enforced by authorization check #12 for campaigns in test mode.';

-- -----------------------------------------------------------------------------
-- compliance_settings : the organisation details every campaign footer must
-- carry. Kept here (rather than in code) so the same values reach the rendered
-- email, the approval gate, and the UI.
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.compliance_settings (
  id              boolean PRIMARY KEY DEFAULT true,
  org_name        text,
  postal_address  text,
  reply_to        citext,
  -- Origin used to build unsubscribe links, e.g. https://campaigns.example.com
  app_base_url    text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  CONSTRAINT compliance_settings_singleton CHECK (id = true)
);

INSERT INTO campaign.compliance_settings (id) VALUES (true);

