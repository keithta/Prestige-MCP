-- =============================================================================
-- 0002  Enumerated types
-- =============================================================================
-- Enums (rather than free text + CHECK) because these values are referenced by
-- the state-machine transition table, by generated TypeScript types, and by
-- authorization logic. A typo should fail at write time, not at send time.
-- =============================================================================

-- Lifecycle of a single intended email. See docs/ARCHITECTURE.md for the
-- transition diagram; the legal transitions themselves live in
-- campaign.allowed_transitions (migration 0010).
CREATE TYPE campaign.job_status AS ENUM (
  'pending',               -- materialized, not yet released to the queue
  'queued',                -- eligible for claiming, subject to authorization
  'claimed',               -- leased by a worker, not yet handed to Graph
  'sending',               -- request in flight to Microsoft Graph
  'sent',                  -- Graph accepted the message
  'failed_retryable',      -- failed; will return to queued after backoff
  'failed_permanent',      -- failed; will not be retried
  'held',                  -- campaign paused or emergency stop engaged
  'cancelled',             -- campaign stopped, or recipient removed
  'suppressed',            -- recipient on the suppression list
  'skipped',               -- never became eligible before the campaign ended
  'needs_reconciliation',  -- outcome unknown; must be resolved against Sent Items
  'bounced',               -- delivered to Graph but later hard-bounced
  'complained'             -- recipient reported the message as spam
);

CREATE TYPE campaign.campaign_status AS ENUM (
  'draft',
  'pending_approval',
  'approved',
  'scheduled',
  'running',
  'paused',
  'stopping',
  'stopped',
  'completed',
  'failed',
  'archived'
);

-- test  -> only addresses in campaign.test_recipients are reachable
-- production -> requires system_controls.production_mode = true as well
CREATE TYPE campaign.send_mode AS ENUM ('test', 'production');

CREATE TYPE campaign.sender_status AS ENUM ('active', 'paused', 'disabled');

CREATE TYPE campaign.suppression_reason AS ENUM (
  'unsubscribe',
  'bounce_hard',
  'bounce_soft',
  'complaint',
  'manual',
  'domain_block',
  'invalid_address'
);

CREATE TYPE campaign.suppression_scope AS ENUM ('global', 'campaign');

-- How the worker classifies a Graph failure. The DATABASE decides what to do
-- with each class (retry, fail, pause the sender); the worker only reports.
CREATE TYPE campaign.failure_class AS ENUM (
  'retryable_throttle',    -- 429 / 503 with Retry-After
  'retryable_transient',   -- 5xx, timeouts, connection resets before the request landed
  'permanent_recipient',   -- bad address, rejected recipient
  'permanent_auth',        -- token/credential problem
  'permanent_policy',      -- access policy or licence denies the send
  'permanent_content',     -- message rejected on content/size grounds
  'ambiguous'              -- request may or may not have been delivered
);

CREATE TYPE campaign.contact_status AS ENUM ('active', 'inactive', 'deleted');

CREATE TYPE campaign.app_role AS ENUM ('owner', 'approver', 'operator', 'viewer');

CREATE TYPE campaign.actor_type AS ENUM ('user', 'worker', 'system', 'n8n', 'public');

CREATE TYPE campaign.alert_severity AS ENUM ('info', 'warning', 'critical');

CREATE TYPE campaign.import_status AS ENUM ('pending', 'analyzing', 'ready', 'committed', 'failed');
