-- =============================================================================
-- 0001  Schema, extensions, and shared helpers
-- =============================================================================
-- Everything this application owns lives in the `campaign` schema so it can sit
-- alongside unrelated tables (e.g. public.tasks) without collision.
--
-- Portability note: these migrations must run BOTH on Supabase and on a plain
-- PostgreSQL cluster (used for integration and concurrency testing). That means
-- no dependency on the `auth` schema and no dependency on Supabase-only
-- functions. Where Supabase would use auth.uid(), we define an equivalent
-- helper that reads the same JWT claim and simply returns NULL off-platform.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS campaign;

-- citext gives us case-insensitive email comparison at the type level, so a
-- duplicate can never slip through because of casing.
--
-- The target schema is explicit. Without it, CREATE EXTENSION follows
-- search_path, and a connecting role named `campaign` makes "$user" resolve to
-- our own schema -- which would then put citext's operators inside the schema
-- whose function privileges we lock down in 0017, breaking every `=`
-- comparison. On Supabase citext already exists in `extensions`, so this is a
-- no-op there.
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;

-- Nothing is reachable by default; every role is granted explicitly later.
REVOKE ALL ON SCHEMA campaign FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Identity of the acting principal.
-- On Supabase this returns the authenticated user id (the same claim auth.uid()
-- reads). Locally it returns NULL unless a test sets request.jwt.claims.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT NULLIF(
    COALESCE(
      current_setting('request.jwt.claim.sub', true),
      (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

COMMENT ON FUNCTION campaign.current_user_id() IS
  'Authenticated user id from the request JWT; NULL for worker/system connections.';

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = campaign, public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- Canonical email form. This is the single definition of "the same address",
-- used by contacts, suppressions, the test allowlist, and duplicate detection.
-- Deliberately conservative: lowercase + trim only. We do NOT strip dots or
-- +tags, because for most providers those are genuinely different mailboxes and
-- silently merging them would drop real recipients.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.canonical_email(p_email text)
RETURNS citext
LANGUAGE sql
IMMUTABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT lower(btrim(p_email))::citext;
$$;

-- Domain part of an address, for domain-level suppression.
CREATE OR REPLACE FUNCTION campaign.email_domain(p_email text)
RETURNS citext
LANGUAGE sql
IMMUTABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT lower(split_part(btrim(p_email), '@', 2))::citext;
$$;

-- Deterministic content hash. Used to bind an approval to exact content, so a
-- post-approval edit is detectable at send time rather than trusted.
-- chr(31) (unit separator) joins the parts so that moving text between fields
-- changes the hash.
CREATE OR REPLACE FUNCTION campaign.content_hash(
  p_subject text, p_html text, p_text text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT encode(
    sha256(convert_to(
      coalesce(p_subject, '') || chr(31) || coalesce(p_html, '') || chr(31) || coalesce(p_text, ''),
      'UTF8')),
    'hex');
$$;

-- Reject timezone strings Postgres does not know, at write time rather than at
-- send time. A bad timezone would otherwise make a schedule window unevaluable.
CREATE OR REPLACE FUNCTION campaign.is_valid_timezone(p_tz text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz);
$$;
