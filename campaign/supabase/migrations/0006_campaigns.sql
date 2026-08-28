-- =============================================================================
-- 0006  Campaigns, content versions, schedules, audiences
-- =============================================================================

CREATE TABLE campaign.campaigns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  description         text,
  sender_account_id   uuid NOT NULL REFERENCES campaign.sender_accounts(id) ON DELETE RESTRICT,
  status              campaign.campaign_status NOT NULL DEFAULT 'draft',
  -- Ships in test mode. Reaching real recipients takes two deliberate flips:
  -- this to 'production', and system_controls.production_mode to true.
  send_mode           campaign.send_mode NOT NULL DEFAULT 'test',

  -- Content lives in campaign_content_versions; this points at the live one.
  current_version_id  uuid,

  -- Approval binds to an exact content hash. If content changes afterwards the
  -- hashes diverge and authorization check #4 refuses every remaining job.
  approved_content_hash text,
  approved_by         uuid,
  approved_at         timestamptz,
  approval_note       text,

  -- "How many contacts should receive this campaign." NULL = the whole audience.
  target_count        integer,

  max_attempts        integer NOT NULL DEFAULT 5,

  -- A campaign that is failing badly stops itself rather than burning the
  -- sending reputation of the mailbox.
  failure_threshold_consecutive integer NOT NULL DEFAULT 10,
  failure_threshold_rate        numeric(4,3) NOT NULL DEFAULT 0.250,
  failure_rate_window           integer NOT NULL DEFAULT 50,
  consecutive_failures          integer NOT NULL DEFAULT 0,

  paused_reason       text,
  paused_at           timestamptz,
  paused_by           uuid,
  stopped_reason      text,
  stopped_at          timestamptz,
  stopped_by          uuid,

  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  completed_at        timestamptz,

  CONSTRAINT campaigns_name_not_blank      CHECK (btrim(name) <> ''),
  CONSTRAINT campaigns_max_attempts_range  CHECK (max_attempts BETWEEN 1 AND 20),
  CONSTRAINT campaigns_target_count_positive CHECK (target_count IS NULL OR target_count > 0),
  CONSTRAINT campaigns_failure_rate_range   CHECK (failure_threshold_rate > 0 AND failure_threshold_rate <= 1),
  CONSTRAINT campaigns_failure_window_range CHECK (failure_rate_window BETWEEN 5 AND 1000),
  -- An approved campaign must carry the hash it was approved against.
  CONSTRAINT campaigns_approval_complete
    CHECK ((approved_at IS NULL) = (approved_content_hash IS NULL))
);

CREATE TRIGGER campaigns_set_updated_at
  BEFORE UPDATE ON campaign.campaigns
  FOR EACH ROW EXECUTE FUNCTION campaign.set_updated_at();

CREATE INDEX campaigns_status_idx ON campaign.campaigns (status);
CREATE INDEX campaigns_sender_idx ON campaign.campaigns (sender_account_id);

-- -----------------------------------------------------------------------------
-- campaign_content_versions : immutable snapshots of what the email says.
-- Editing a campaign creates a new version rather than mutating the old one, so
-- an approval always refers to something that still exists exactly as approved.
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.campaign_content_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id        uuid NOT NULL REFERENCES campaign.campaigns(id) ON DELETE CASCADE,
  version            integer NOT NULL,
  subject_template   text NOT NULL,
  body_html_template text,
  body_text_template text,
  content_hash       text NOT NULL,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, version),
  CONSTRAINT content_subject_not_blank CHECK (btrim(subject_template) <> ''),
  CONSTRAINT content_has_a_body
    CHECK (COALESCE(btrim(body_html_template), '') <> '' OR COALESCE(btrim(body_text_template), '') <> '')
);

ALTER TABLE campaign.campaigns
  ADD CONSTRAINT campaigns_current_version_fk
  FOREIGN KEY (current_version_id)
  REFERENCES campaign.campaign_content_versions(id) ON DELETE SET NULL;

-- Content versions are immutable once written.
CREATE OR REPLACE FUNCTION campaign.reject_content_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = campaign, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'campaign_content_versions is immutable (attempted % on version %). Create a new version instead.',
    TG_OP, COALESCE(OLD.version, -1)
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER content_versions_immutable
  BEFORE UPDATE OR DELETE ON campaign.campaign_content_versions
  FOR EACH ROW EXECUTE FUNCTION campaign.reject_content_version_mutation();

-- Keep content_hash honest: always derived, never supplied.
CREATE OR REPLACE FUNCTION campaign.set_content_hash()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = campaign, public, pg_temp
AS $$
BEGIN
  NEW.content_hash := campaign.content_hash(
    NEW.subject_template, NEW.body_html_template, NEW.body_text_template);
  IF NEW.version IS NULL THEN
    SELECT COALESCE(MAX(version), 0) + 1 INTO NEW.version
    FROM campaign.campaign_content_versions WHERE campaign_id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_versions_derive_hash
  BEFORE INSERT ON campaign.campaign_content_versions
  FOR EACH ROW EXECUTE FUNCTION campaign.set_content_hash();

-- -----------------------------------------------------------------------------
-- campaign_schedules : allowed days/hours and cadence. One row per campaign.
-- This is DATA, evaluated in SQL at authorization time -- not a cron expression
-- that fires sends.
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.campaign_schedules (
  campaign_id      uuid PRIMARY KEY REFERENCES campaign.campaigns(id) ON DELETE CASCADE,
  timezone         text NOT NULL DEFAULT 'UTC',
  -- ISO day numbers: 1 = Monday ... 7 = Sunday. Default: weekdays.
  allowed_days     smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::smallint[],
  window_start     time NOT NULL DEFAULT '09:00',
  window_end       time NOT NULL DEFAULT '17:00',
  start_at         timestamptz,
  end_at           timestamptz,
  emails_per_hour  integer NOT NULL DEFAULT 30,
  emails_per_day   integer NOT NULL DEFAULT 200,
  min_gap_seconds  integer NOT NULL DEFAULT 4,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_timezone_valid CHECK (campaign.is_valid_timezone(timezone)),
  CONSTRAINT schedule_window_ordered CHECK (window_start < window_end),
  CONSTRAINT schedule_dates_ordered  CHECK (start_at IS NULL OR end_at IS NULL OR start_at < end_at),
  CONSTRAINT schedule_rates_positive CHECK (emails_per_hour > 0 AND emails_per_day > 0),
  CONSTRAINT schedule_hourly_le_daily CHECK (emails_per_hour <= emails_per_day),
  CONSTRAINT schedule_gap_range       CHECK (min_gap_seconds >= 0 AND min_gap_seconds <= 3600),
  CONSTRAINT schedule_days_present    CHECK (array_length(allowed_days, 1) BETWEEN 1 AND 7),
  CONSTRAINT schedule_days_valid
    CHECK (allowed_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[])
);

CREATE TRIGGER campaign_schedules_set_updated_at
  BEFORE UPDATE ON campaign.campaign_schedules
  FOR EACH ROW EXECUTE FUNCTION campaign.set_updated_at();

-- -----------------------------------------------------------------------------
-- campaign_recipients : the materialized audience.
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.campaign_recipients (
  campaign_id uuid NOT NULL REFERENCES campaign.campaigns(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES campaign.contacts(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  added_by    uuid,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, contact_id)
);

CREATE INDEX campaign_recipients_order_idx
  ON campaign.campaign_recipients (campaign_id, position);

COMMENT ON TABLE campaign.campaign_recipients IS
  'Frozen audience for a campaign. PRIMARY KEY (campaign_id, contact_id) is duplicate-protection layer 1.';

-- -----------------------------------------------------------------------------
-- Is this campaign inside its allowed sending window right now?
-- Single definition, used by authorization and mirrored (read-only) by the UI.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign.is_within_window(
  p_campaign_id uuid,
  p_at timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = campaign, public, pg_temp
AS $$
  -- COALESCE matters: a campaign with no schedule row must be OUT of window,
  -- not NULL. Defaulting to false keeps "no schedule" a refusal to send.
  SELECT COALESCE((
    SELECT
      (s.start_at IS NULL OR p_at >= s.start_at)
      AND (s.end_at IS NULL OR p_at < s.end_at)
      -- Local wall-clock in the campaign's timezone; DST-correct because the
      -- conversion happens against the actual instant.
      AND EXTRACT(ISODOW FROM (p_at AT TIME ZONE s.timezone))::smallint = ANY (s.allowed_days)
      AND (p_at AT TIME ZONE s.timezone)::time >= s.window_start
      AND (p_at AT TIME ZONE s.timezone)::time <  s.window_end
    FROM campaign.campaign_schedules s
    WHERE s.campaign_id = p_campaign_id
  ), false);
$$;
