-- =============================================================================
-- 0007  email_jobs, attempts, and send counters
-- =============================================================================
-- email_jobs is the unit of authorization. One row = one intended email to one
-- recipient. Everything the worker needs is SNAPSHOTTED here at materialization
-- time, so a send is reproducible and an audit can show exactly what went out.
-- =============================================================================

CREATE TABLE campaign.email_jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id          uuid NOT NULL REFERENCES campaign.campaigns(id) ON DELETE CASCADE,
  contact_id           uuid NOT NULL REFERENCES campaign.contacts(id) ON DELETE RESTRICT,
  sender_account_id    uuid NOT NULL REFERENCES campaign.sender_accounts(id) ON DELETE RESTRICT,

  -- Which content this job was built from, and its hash. Authorization compares
  -- this hash against the campaign's approved hash on every claim, so content
  -- edited after approval cannot reach a recipient.
  content_version_id   uuid REFERENCES campaign.campaign_content_versions(id) ON DELETE SET NULL,
  content_version_hash text NOT NULL,

  -- Rendered snapshots. The worker sends these verbatim and renders nothing.
  recipient_email      citext NOT NULL,
  recipient_name       text,
  subject              text NOT NULL,
  body_html            text,
  body_text            text,

  status               campaign.job_status NOT NULL DEFAULT 'pending',

  -- Duplicate-protection layer 2: derived from campaign + contact + content.
  idempotency_key      text NOT NULL,
  -- Stable across retries. Sent to Graph as client-request-id and embedded in
  -- the message as x-campaign-job-id, which is what makes an ambiguous send
  -- resolvable by evidence instead of by guessing.
  client_request_id    uuid NOT NULL DEFAULT gen_random_uuid(),
  -- Opaque, unguessable handle for the one-click unsubscribe link. Deliberately
  -- a random token rather than an HMAC: it keeps any signing secret out of the
  -- database entirely, and it can be revoked per job.
  unsubscribe_token    uuid NOT NULL DEFAULT gen_random_uuid(),

  priority             integer NOT NULL DEFAULT 100,
  attempt_count        integer NOT NULL DEFAULT 0,
  max_attempts         integer NOT NULL DEFAULT 5,

  scheduled_for        timestamptz NOT NULL DEFAULT now(),
  -- Backoff gate. A retryable failure pushes this forward; nothing is claimable
  -- before it.
  available_at         timestamptz NOT NULL DEFAULT now(),

  -- Lease held by the claiming worker.
  locked_by            text,
  locked_at            timestamptz,
  lease_expires_at     timestamptz,

  sent_at              timestamptz,
  graph_draft_id       text,
  graph_message_id     text,
  internet_message_id  text,

  last_error_code      text,
  last_error_message   text,
  last_failure_class   campaign.failure_class,
  -- Machine-readable answer to "why didn't this send?"
  skip_reason          text,
  suppressed_reason    campaign.suppression_reason,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT email_jobs_attempts_range CHECK (attempt_count >= 0 AND max_attempts BETWEEN 1 AND 20),
  CONSTRAINT email_jobs_subject_not_blank CHECK (btrim(subject) <> ''),
  CONSTRAINT email_jobs_has_body
    CHECK (COALESCE(btrim(body_html), '') <> '' OR COALESCE(btrim(body_text), '') <> ''),
  CONSTRAINT email_jobs_recipient_shape
    CHECK (recipient_email ~ '^[^@[:space:],;<>]+@[^@[:space:],;<>]+[.][^@[:space:],;<>]+$'),
  -- A job marked sent must carry proof of when.
  CONSTRAINT email_jobs_sent_has_timestamp
    CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  -- A leased job must say who holds the lease and until when.
  CONSTRAINT email_jobs_lease_consistent
    CHECK (status NOT IN ('claimed', 'sending')
           OR (locked_by IS NOT NULL AND lease_expires_at IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Duplicate-protection indexes
-- ---------------------------------------------------------------------------

-- Layer 1: one job per contact per campaign.
CREATE UNIQUE INDEX email_jobs_campaign_contact_key
  ON campaign.email_jobs (campaign_id, contact_id);

-- Layer 2: idempotency key is globally unique.
CREATE UNIQUE INDEX email_jobs_idempotency_key
  ON campaign.email_jobs (idempotency_key);

CREATE UNIQUE INDEX email_jobs_client_request_id_key
  ON campaign.email_jobs (client_request_id);

CREATE UNIQUE INDEX email_jobs_unsubscribe_token_key
  ON campaign.email_jobs (unsubscribe_token);

-- Layer 3: at most one live job per ADDRESS per campaign. This catches the case
-- layer 1 cannot: two different contact rows that share an email address.
-- Cancelled jobs are excluded so an address can be re-added after a removal.
CREATE UNIQUE INDEX email_jobs_one_live_per_recipient
  ON campaign.email_jobs (campaign_id, recipient_email)
  WHERE status <> 'cancelled';

-- ---------------------------------------------------------------------------
-- Claim-path index. The claim query filters on status + availability and orders
-- by priority/schedule; this index serves exactly that access pattern.
-- ---------------------------------------------------------------------------
CREATE INDEX email_jobs_claimable_idx
  ON campaign.email_jobs (available_at, priority, scheduled_for, created_at)
  WHERE status = 'queued';

CREATE INDEX email_jobs_campaign_status_idx ON campaign.email_jobs (campaign_id, status);
CREATE INDEX email_jobs_sender_status_idx   ON campaign.email_jobs (sender_account_id, status);
CREATE INDEX email_jobs_recipient_idx       ON campaign.email_jobs (recipient_email);
CREATE INDEX email_jobs_sent_at_idx         ON campaign.email_jobs (sent_at DESC) WHERE status = 'sent';

-- Lease reaping looks for expired leases only.
CREATE INDEX email_jobs_lease_idx
  ON campaign.email_jobs (lease_expires_at)
  WHERE status IN ('claimed', 'sending');

CREATE TRIGGER email_jobs_set_updated_at
  BEFORE UPDATE ON campaign.email_jobs
  FOR EACH ROW EXECUTE FUNCTION campaign.set_updated_at();

-- Derive the idempotency key rather than trusting a caller to supply one.
CREATE OR REPLACE FUNCTION campaign.set_idempotency_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = campaign, public, pg_temp
AS $$
BEGIN
  NEW.idempotency_key := encode(
    sha256(convert_to(
      NEW.campaign_id::text || chr(31) || NEW.contact_id::text || chr(31) || NEW.content_version_hash,
      'UTF8')),
    'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER email_jobs_derive_idempotency_key
  BEFORE INSERT ON campaign.email_jobs
  FOR EACH ROW EXECUTE FUNCTION campaign.set_idempotency_key();

COMMENT ON TABLE campaign.email_jobs IS
  'One intended email. The only object the sending worker may consume, and only via campaign.claim_email_jobs().';

-- -----------------------------------------------------------------------------
-- email_job_attempts : append-only history, one row per Graph attempt.
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.email_job_attempts (
  id                      bigserial PRIMARY KEY,
  job_id                  uuid NOT NULL REFERENCES campaign.email_jobs(id) ON DELETE CASCADE,
  attempt_no              integer NOT NULL,
  worker_id               text,
  started_at              timestamptz NOT NULL DEFAULT now(),
  finished_at             timestamptz,
  duration_ms             integer,
  outcome                 text NOT NULL DEFAULT 'pending',
  http_status             integer,
  -- Microsoft's own correlation ids: quote these in a support case.
  graph_request_id        text,
  graph_client_request_id text,
  failure_class           campaign.failure_class,
  error_code              text,
  error_message           text,
  retry_after_seconds     integer,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, attempt_no),
  CONSTRAINT attempt_outcome_valid
    CHECK (outcome IN ('pending', 'sent', 'failed', 'ambiguous'))
);

CREATE INDEX email_job_attempts_job_idx ON campaign.email_job_attempts (job_id, attempt_no DESC);
CREATE INDEX email_job_attempts_failed_idx
  ON campaign.email_job_attempts (created_at DESC) WHERE outcome = 'failed';

-- -----------------------------------------------------------------------------
-- send_counters : hourly buckets per (sender, campaign).
-- Daily and hourly limits are derived by summing these, with day boundaries
-- computed in the sender's own timezone.
-- -----------------------------------------------------------------------------
CREATE TABLE campaign.send_counters (
  sender_account_id uuid NOT NULL REFERENCES campaign.sender_accounts(id) ON DELETE CASCADE,
  campaign_id       uuid NOT NULL REFERENCES campaign.campaigns(id) ON DELETE CASCADE,
  bucket_hour       timestamptz NOT NULL,
  sent_count        integer NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_account_id, campaign_id, bucket_hour),
  CONSTRAINT send_counters_nonneg CHECK (sent_count >= 0),
  CONSTRAINT send_counters_bucket_aligned CHECK (bucket_hour = date_trunc('hour', bucket_hour))
);

CREATE INDEX send_counters_hour_idx ON campaign.send_counters (bucket_hour DESC);
CREATE INDEX send_counters_campaign_idx ON campaign.send_counters (campaign_id, bucket_hour DESC);

COMMENT ON TABLE campaign.send_counters IS
  'Authoritative send volume. Incremented in the same transaction that marks a job sent, so a limit can never be exceeded by a race.';
