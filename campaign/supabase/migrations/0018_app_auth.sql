-- =============================================================================
-- 0018  Operator credentials
-- =============================================================================
-- The admin application authenticates operators against app_profiles. The hash
-- is scrypt, computed in the application; Postgres only ever stores the result.
--
-- This is deliberately separable from Supabase Auth: everything downstream
-- depends only on a user id reaching request.jwt.claims, which is exactly what
-- Supabase provides. Pointing the app at Supabase Auth later changes sign-in
-- and nothing else.
-- =============================================================================

ALTER TABLE campaign.app_profiles
  ADD COLUMN password_hash text,
  ADD COLUMN last_login_at timestamptz;

-- The hash must never be readable through the API surface, even by an owner.
REVOKE ALL (password_hash) ON campaign.app_profiles FROM authenticated, anon, campaign_readonly;

COMMENT ON COLUMN campaign.app_profiles.password_hash IS
  'scrypt$<salt hex>$<derived hex>. Readable only by the server-side connection.';

-- -----------------------------------------------------------------------------
-- Creating the first operator. Refuses once any account exists, so it cannot be
-- used to quietly mint a second owner later.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.bootstrap_owner(
  p_email         text,
  p_password_hash text,
  p_full_name     text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM campaign.app_profiles) THEN
    RAISE EXCEPTION 'an operator account already exists; use campaign.create_operator() instead'
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO campaign.app_profiles (id, email, full_name, role, password_hash)
  VALUES (gen_random_uuid(), campaign.canonical_email(p_email), p_full_name, 'owner', p_password_hash)
  RETURNING id INTO v_id;

  PERFORM campaign.write_audit(
    p_action => 'operator.bootstrapped', p_entity_type => 'app_profile',
    p_entity_id => v_id::text, p_actor_type => 'system',
    p_metadata => jsonb_build_object('email', campaign.canonical_email(p_email), 'role', 'owner'));

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION campaign.create_operator(
  p_email         text,
  p_password_hash text,
  p_role          campaign.app_role,
  p_full_name     text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT campaign.has_role('owner') THEN
    RAISE EXCEPTION 'only an owner may create operator accounts' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO campaign.app_profiles (id, email, full_name, role, password_hash)
  VALUES (gen_random_uuid(), campaign.canonical_email(p_email), p_full_name, p_role, p_password_hash)
  RETURNING id INTO v_id;

  PERFORM campaign.write_audit(
    p_action => 'operator.created', p_entity_type => 'app_profile', p_entity_id => v_id::text,
    p_metadata => jsonb_build_object('email', campaign.canonical_email(p_email), 'role', p_role));

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION campaign.bootstrap_owner(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION campaign.create_operator(text, text, campaign.app_role, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- Resolving a one-click unsubscribe token to the address that should be
-- suppressed. The token is the only thing the public endpoint ever sees; the
-- address is never in the URL, so a link cannot be used to enumerate contacts.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.unsubscribe_by_token(p_token uuid)
RETURNS TABLE (ok boolean, campaign_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  j campaign.email_jobs%ROWTYPE;
  c campaign.campaigns%ROWTYPE;
BEGIN
  SELECT * INTO j FROM campaign.email_jobs WHERE unsubscribe_token = p_token;
  IF NOT FOUND THEN
    -- Deliberately indistinguishable from success to the caller: a bad token
    -- must not reveal whether it was ever valid.
    RETURN QUERY SELECT false, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO c FROM campaign.campaigns WHERE id = j.campaign_id;
  PERFORM campaign.add_suppression(
    j.recipient_email::text, 'unsubscribe', 'global', NULL, 'unsubscribe_link',
    format('One-click unsubscribe from campaign "%s"', COALESCE(c.name, '?')));

  RETURN QUERY SELECT true, c.name;
END;
$$;

GRANT EXECUTE ON FUNCTION campaign.unsubscribe_by_token(uuid) TO anon, authenticated, service_role;
