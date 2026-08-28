-- =============================================================================
-- 0004  Contacts, lists, and import batches
-- =============================================================================

-- -----------------------------------------------------------------------------
-- contact_lists : named groupings used to build a campaign audience.
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.contact_lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT contact_lists_name_not_blank CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX contact_lists_name_key
  ON campaign.contact_lists (lower(name)) WHERE archived_at IS NULL;

CREATE TRIGGER contact_lists_set_updated_at
  BEFORE UPDATE ON campaign.contact_lists
  FOR EACH ROW EXECUTE FUNCTION campaign.set_updated_at();

-- -----------------------------------------------------------------------------
-- import_batches : one row per upload. Every import is a recorded event, and a
-- dry run is a first-class outcome so the operator sees exactly what would
-- happen before anything is written.
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.import_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename         text,
  status           campaign.import_status NOT NULL DEFAULT 'pending',
  dry_run          boolean NOT NULL DEFAULT true,
  total_rows       integer NOT NULL DEFAULT 0,
  inserted_count   integer NOT NULL DEFAULT 0,
  updated_count    integer NOT NULL DEFAULT 0,
  skipped_count    integer NOT NULL DEFAULT 0,
  error_count      integer NOT NULL DEFAULT 0,
  suppressed_count integer NOT NULL DEFAULT 0,
  column_mapping   jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_list_id   uuid REFERENCES campaign.contact_lists(id) ON DELETE SET NULL,
  notes            text,
  uploaded_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT import_counts_nonneg CHECK (
    total_rows >= 0 AND inserted_count >= 0 AND updated_count >= 0
    AND skipped_count >= 0 AND error_count >= 0 AND suppressed_count >= 0
  )
);

-- -----------------------------------------------------------------------------
-- contacts
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- As supplied, for display and sending (people notice mangled casing).
  email            citext NOT NULL,
  -- The identity key. Generated, never supplied by a caller, so no code path
  -- can insert a contact whose canonical form disagrees with its address.
  email_canonical  citext NOT NULL
    GENERATED ALWAYS AS (lower(btrim(email::text))::citext) STORED,
  first_name       text,
  last_name        text,
  company          text,
  job_title        text,
  phone            text,
  -- Extra columns from an import, exposed as merge fields.
  attributes       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           campaign.contact_status NOT NULL DEFAULT 'active',
  -- Provenance matters for consent defensibility (CAN-SPAM / CASL / GDPR).
  source           text,
  consent_note     text,
  import_batch_id  uuid REFERENCES campaign.import_batches(id) ON DELETE SET NULL,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Soft delete: the row is retained so the address stays claimed and a
  -- re-import cannot silently resurrect it as a brand-new contact.
  deleted_at       timestamptz,
  CONSTRAINT contacts_email_shape
    CHECK (email ~ '^[^@[:space:],;<>]+@[^@[:space:],;<>]+[.][^@[:space:],;<>]+$'),
  CONSTRAINT contacts_attributes_is_object
    CHECK (jsonb_typeof(attributes) = 'object')
);

-- One row per address, always. Duplicate protection starts here.
CREATE UNIQUE INDEX contacts_email_canonical_key
  ON campaign.contacts (email_canonical);

CREATE TRIGGER contacts_set_updated_at
  BEFORE UPDATE ON campaign.contacts
  FOR EACH ROW EXECUTE FUNCTION campaign.set_updated_at();

-- -----------------------------------------------------------------------------
-- import_errors : per-row rejections, so a failed import is diagnosable
-- without re-running it.
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.import_errors (
  id            bigserial PRIMARY KEY,
  batch_id      uuid NOT NULL REFERENCES campaign.import_batches(id) ON DELETE CASCADE,
  row_number    integer NOT NULL,
  raw_row       jsonb,
  error_code    text NOT NULL,
  error_message text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX import_errors_batch_idx ON campaign.import_errors (batch_id, row_number);

-- -----------------------------------------------------------------------------
-- contact_list_members
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.contact_list_members (
  list_id    uuid NOT NULL REFERENCES campaign.contact_lists(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES campaign.contacts(id) ON DELETE CASCADE,
  added_by   uuid,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, contact_id)
);

CREATE INDEX contact_list_members_contact_idx
  ON campaign.contact_list_members (contact_id);
