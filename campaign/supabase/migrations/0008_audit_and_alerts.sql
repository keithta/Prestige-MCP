-- =============================================================================
-- 0008  Audit trail and alerts
-- =============================================================================

-- -----------------------------------------------------------------------------
-- audit_events : append-only. UPDATE and DELETE are revoked in 0017 AND blocked
-- by a trigger here, so even a superuser mistake is caught rather than silently
-- rewriting history.
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.audit_events (
  id           bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_type   campaign.actor_type NOT NULL DEFAULT 'system',
  actor_id     uuid,
  actor_label  text,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  -- Denormalized so the common filters need no joins.
  campaign_id  uuid,
  job_id       uuid,
  -- Machine-readable outcome, e.g. 'emergency_stop_engaged', 'window_closed'.
  reason_code  text,
  before_state jsonb,
  after_state  jsonb,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address   inet,
  user_agent   text,
  CONSTRAINT audit_action_not_blank CHECK (btrim(action) <> '')
);

CREATE INDEX audit_events_occurred_idx  ON campaign.audit_events (occurred_at DESC);
CREATE INDEX audit_events_campaign_idx  ON campaign.audit_events (campaign_id, occurred_at DESC);
CREATE INDEX audit_events_job_idx       ON campaign.audit_events (job_id, occurred_at DESC);
CREATE INDEX audit_events_action_idx    ON campaign.audit_events (action, occurred_at DESC);
CREATE INDEX audit_events_actor_idx     ON campaign.audit_events (actor_id, occurred_at DESC);
CREATE INDEX audit_events_reason_idx    ON campaign.audit_events (reason_code, occurred_at DESC)
  WHERE reason_code IS NOT NULL;

CREATE OR REPLACE FUNCTION campaign.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = campaign, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'campaign.audit_events is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON campaign.audit_events
  FOR EACH ROW EXECUTE FUNCTION campaign.reject_audit_mutation();

COMMENT ON TABLE campaign.audit_events IS
  'Append-only audit trail. Every state transition, control change, and authorization denial lands here.';

-- -----------------------------------------------------------------------------
-- The single entry point for writing audit rows. SECURITY DEFINER so callers
-- need no direct INSERT privilege on the table.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.write_audit(
  p_action      text,
  p_entity_type text DEFAULT NULL,
  p_entity_id   text DEFAULT NULL,
  p_actor_type  campaign.actor_type DEFAULT NULL,
  p_actor_id    uuid DEFAULT NULL,
  p_actor_label text DEFAULT NULL,
  p_campaign_id uuid DEFAULT NULL,
  p_job_id      uuid DEFAULT NULL,
  p_reason_code text DEFAULT NULL,
  p_before      jsonb DEFAULT NULL,
  p_after       jsonb DEFAULT NULL,
  p_metadata    jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  v_actor_id   uuid := COALESCE(p_actor_id, campaign.current_user_id());
  v_actor_type campaign.actor_type := COALESCE(
    p_actor_type,
    CASE WHEN campaign.current_user_id() IS NOT NULL THEN 'user'::campaign.actor_type
         ELSE 'system'::campaign.actor_type END
  );
  v_id bigint;
BEGIN
  INSERT INTO campaign.audit_events (
    actor_type, actor_id, actor_label, action, entity_type, entity_id,
    campaign_id, job_id, reason_code, before_state, after_state, metadata
  ) VALUES (
    v_actor_type, v_actor_id, p_actor_label, p_action, p_entity_type, p_entity_id,
    p_campaign_id, p_job_id, p_reason_code, p_before, p_after, COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- alerts : operational signals drained by n8n (or read in the UI).
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.alerts (
  id                bigserial PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  severity          campaign.alert_severity NOT NULL DEFAULT 'warning',
  -- Stable identity for an ongoing condition, so it is raised once, not per event.
  alert_key         text NOT NULL,
  title             text NOT NULL,
  detail            text,
  campaign_id       uuid REFERENCES campaign.campaigns(id) ON DELETE CASCADE,
  sender_account_id uuid REFERENCES campaign.sender_accounts(id) ON DELETE CASCADE,
  job_id            uuid,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Set once an integration has delivered it, so n8n does not re-notify.
  notified_at       timestamptz,
  acknowledged_at   timestamptz,
  acknowledged_by   uuid,
  resolved_at       timestamptz,
  CONSTRAINT alert_key_not_blank CHECK (btrim(alert_key) <> '')
);

-- One active alert per condition.
CREATE UNIQUE INDEX alerts_active_key ON campaign.alerts (alert_key) WHERE resolved_at IS NULL;
CREATE INDEX alerts_unnotified_idx ON campaign.alerts (created_at)
  WHERE notified_at IS NULL AND resolved_at IS NULL;
CREATE INDEX alerts_open_idx ON campaign.alerts (severity, created_at DESC) WHERE resolved_at IS NULL;

CREATE OR REPLACE FUNCTION campaign.raise_alert(
  p_alert_key text,
  p_severity  campaign.alert_severity,
  p_title     text,
  p_detail    text DEFAULT NULL,
  p_campaign_id uuid DEFAULT NULL,
  p_sender_account_id uuid DEFAULT NULL,
  p_job_id    uuid DEFAULT NULL,
  p_metadata  jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = campaign, public, pg_temp
AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO campaign.alerts (
    alert_key, severity, title, detail, campaign_id, sender_account_id, job_id, metadata
  ) VALUES (
    p_alert_key, p_severity, p_title, p_detail, p_campaign_id, p_sender_account_id, p_job_id,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (alert_key) WHERE resolved_at IS NULL DO UPDATE
    SET detail   = COALESCE(EXCLUDED.detail, campaign.alerts.detail),
        severity = GREATEST(EXCLUDED.severity, campaign.alerts.severity),
        metadata = campaign.alerts.metadata || EXCLUDED.metadata
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
