-- =============================================================================
-- 0005  Suppressions
-- =============================================================================
-- Append-only by policy: an address that asked not to be contacted stays on the
-- record. Removing a suppression is itself an audited insert of a revocation,
-- never a DELETE (see 0016 for the enforcing policy).
-- =============================================================================

CREATE TABLE campaign.suppressions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Exactly one of these is set: a specific address, or a whole domain.
  email_canonical citext,
  domain          citext,
  reason          campaign.suppression_reason NOT NULL,
  scope           campaign.suppression_scope NOT NULL DEFAULT 'global',
  -- Only meaningful when scope = 'campaign'.
  campaign_id     uuid,
  notes           text,
  -- Where it came from: 'unsubscribe_link', 'import', 'manual', 'bounce', ...
  source          text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A suppression can be lifted (rare, audited), but the row survives.
  revoked_at      timestamptz,
  revoked_by      uuid,
  revoke_reason   text,
  CONSTRAINT suppression_target_exactly_one
    CHECK ((email_canonical IS NOT NULL) <> (domain IS NOT NULL)),
  CONSTRAINT suppression_campaign_scope_consistent
    CHECK ((scope = 'campaign') = (campaign_id IS NOT NULL))
);

-- At most one ACTIVE suppression per address per scope. Re-suppressing an
-- already-suppressed address is a no-op rather than a duplicate row.
CREATE UNIQUE INDEX suppressions_active_email_global
  ON campaign.suppressions (email_canonical)
  WHERE revoked_at IS NULL AND scope = 'global' AND email_canonical IS NOT NULL;

CREATE UNIQUE INDEX suppressions_active_email_campaign
  ON campaign.suppressions (campaign_id, email_canonical)
  WHERE revoked_at IS NULL AND scope = 'campaign' AND email_canonical IS NOT NULL;

CREATE UNIQUE INDEX suppressions_active_domain_global
  ON campaign.suppressions (domain)
  WHERE revoked_at IS NULL AND scope = 'global' AND domain IS NOT NULL;

CREATE UNIQUE INDEX suppressions_active_domain_campaign
  ON campaign.suppressions (campaign_id, domain)
  WHERE revoked_at IS NULL AND scope = 'campaign' AND domain IS NOT NULL;

-- Hot path: authorization check #8 runs this lookup for every claimed job.
CREATE INDEX suppressions_lookup_idx
  ON campaign.suppressions (email_canonical, scope)
  WHERE revoked_at IS NULL;

CREATE INDEX suppressions_domain_lookup_idx
  ON campaign.suppressions (domain, scope)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE campaign.suppressions IS
  'Do-not-contact list. Checked at claim time AND immediately before the Graph call, so an unsubscribe lands even mid-campaign.';

-- -----------------------------------------------------------------------------
-- is_suppressed : the single definition of "must not contact this address".
-- Used by authorization, by the import preview, and by the UI.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.is_suppressed(
  p_email text,
  p_campaign_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM campaign.suppressions s
    WHERE s.revoked_at IS NULL
      AND (
        s.email_canonical = campaign.canonical_email(p_email)
        OR s.domain = campaign.email_domain(p_email)
      )
      AND (
        s.scope = 'global'
        OR (s.scope = 'campaign' AND p_campaign_id IS NOT NULL AND s.campaign_id = p_campaign_id)
      )
  );
$$;

-- Same test, but returns WHY -- so the UI can explain a skipped send.
CREATE OR REPLACE FUNCTION campaign.suppression_reason_for(
  p_email text,
  p_campaign_id uuid DEFAULT NULL
)
RETURNS campaign.suppression_reason
LANGUAGE sql
STABLE
SET search_path = campaign, public, pg_temp
AS $$
  SELECT s.reason
  FROM campaign.suppressions s
  WHERE s.revoked_at IS NULL
    AND (
      s.email_canonical = campaign.canonical_email(p_email)
      OR s.domain = campaign.email_domain(p_email)
    )
    AND (
      s.scope = 'global'
      OR (s.scope = 'campaign' AND p_campaign_id IS NOT NULL AND s.campaign_id = p_campaign_id)
    )
  -- Prefer the strongest signal if an address matches more than one rule.
  ORDER BY CASE s.reason
             WHEN 'complaint'   THEN 1
             WHEN 'unsubscribe' THEN 2
             WHEN 'bounce_hard' THEN 3
             WHEN 'domain_block' THEN 4
             ELSE 5
           END
  LIMIT 1;
$$;
