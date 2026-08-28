/**
 * Domain types mirroring the `campaign` schema.
 *
 * These are hand-maintained rather than generated so the worker and the web app
 * share one vocabulary even before a Supabase project exists to generate from.
 * `npm run db:types` regenerates a checked copy from a live database.
 */

export type JobStatus =
  | 'pending'
  | 'queued'
  | 'claimed'
  | 'sending'
  | 'sent'
  | 'failed_retryable'
  | 'failed_permanent'
  | 'held'
  | 'cancelled'
  | 'suppressed'
  | 'skipped'
  | 'needs_reconciliation'
  | 'bounced'
  | 'complained';

export type CampaignStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'failed'
  | 'archived';

export type SendMode = 'test' | 'production';
export type SenderStatus = 'active' | 'paused' | 'disabled';
export type AppRole = 'owner' | 'approver' | 'operator' | 'viewer';
export type ContactStatus = 'active' | 'inactive' | 'deleted';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export type SuppressionReason =
  | 'unsubscribe'
  | 'bounce_hard'
  | 'bounce_soft'
  | 'complaint'
  | 'manual'
  | 'domain_block'
  | 'invalid_address';

/**
 * How the worker classifies a Graph failure. The worker reports the class; the
 * DATABASE decides the consequence (retry, fail, suppress, pause the sender).
 */
export type FailureClass =
  | 'retryable_throttle'
  | 'retryable_transient'
  | 'permanent_recipient'
  | 'permanent_auth'
  | 'permanent_policy'
  | 'permanent_content'
  | 'ambiguous';

/** Every reason campaign.send_denial_reason() can return. */
export type DenialReason =
  | 'job_not_found'
  | 'emergency_stop_engaged'
  | 'global_send_disabled'
  | 'job_not_queued'
  | 'backoff_not_elapsed'
  | 'attempts_exhausted'
  | 'campaign_missing'
  | 'campaign_paused'
  | 'campaign_stopping'
  | 'campaign_stopped'
  | 'campaign_not_running'
  | 'campaign_not_approved'
  | 'content_changed_since_approval'
  | 'test_mode_recipient_not_allowed'
  | 'production_mode_disabled'
  | 'sender_missing'
  | 'sender_paused'
  | 'sender_disabled'
  | 'sender_mismatch'
  | 'recipient_suppressed'
  | 'duplicate_recipient_already_sent'
  | 'schedule_missing'
  | 'campaign_not_started'
  | 'campaign_window_ended'
  | 'outside_sending_window'
  | 'sender_hourly_limit_reached'
  | 'sender_daily_limit_reached'
  | 'campaign_hourly_limit_reached'
  | 'campaign_daily_limit_reached'
  | 'min_send_gap_not_elapsed';

/** Human-readable explanations, shown in the admin UI beside a stalled job. */
export const DENIAL_EXPLANATIONS: Record<DenialReason, string> = {
  job_not_found: 'The job no longer exists.',
  emergency_stop_engaged: 'The global emergency stop is engaged. Nothing will send until it is released.',
  global_send_disabled: 'Global sending is switched off in system settings.',
  job_not_queued: 'This job is not in the queue right now.',
  backoff_not_elapsed: 'Waiting out a retry backoff before the next attempt.',
  attempts_exhausted: 'Every permitted attempt has been used.',
  campaign_missing: 'The campaign record is missing.',
  campaign_paused: 'The campaign is paused.',
  campaign_stopping: 'The campaign is stopping.',
  campaign_stopped: 'The campaign has been stopped.',
  campaign_not_running: 'The campaign is not running.',
  campaign_not_approved: 'The campaign has not been approved.',
  content_changed_since_approval:
    'The campaign content changed after it was approved, so this job no longer matches what was approved. Re-approve the campaign.',
  test_mode_recipient_not_allowed:
    'The campaign is in test mode and this recipient is not on the test allowlist.',
  production_mode_disabled:
    'The campaign is in production mode but the global production-mode switch is off.',
  sender_missing: 'The sending mailbox record is missing.',
  sender_paused: 'The sending mailbox is paused.',
  sender_disabled: 'The sending mailbox is disabled.',
  sender_mismatch: "This job's sender no longer matches the campaign's sender.",
  recipient_suppressed: 'The recipient is on the suppression list.',
  duplicate_recipient_already_sent:
    'This campaign has already sent to this address. Blocked to prevent a duplicate.',
  schedule_missing: 'The campaign has no schedule.',
  campaign_not_started: 'The campaign start time has not been reached.',
  campaign_window_ended: 'The campaign end time has passed.',
  outside_sending_window: 'Outside the allowed sending days or hours.',
  sender_hourly_limit_reached: "The mailbox's hourly send limit is reached.",
  sender_daily_limit_reached: "The mailbox's daily send limit is reached.",
  campaign_hourly_limit_reached: "The campaign's hourly send limit is reached.",
  campaign_daily_limit_reached: "The campaign's daily send limit is reached.",
  min_send_gap_not_elapsed: 'Pacing: waiting for the minimum gap between sends.',
};

export function explainDenial(reason: string | null | undefined): string {
  if (!reason) return 'Authorized to send.';
  return DENIAL_EXPLANATIONS[reason as DenialReason] ?? `Refused: ${reason}`;
}

export interface EmailJob {
  id: string;
  campaign_id: string;
  contact_id: string;
  sender_account_id: string;
  content_version_id: string | null;
  content_version_hash: string;
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  body_html: string | null;
  body_text: string | null;
  status: JobStatus;
  idempotency_key: string;
  client_request_id: string;
  unsubscribe_token: string;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  scheduled_for: string;
  available_at: string;
  locked_by: string | null;
  locked_at: string | null;
  lease_expires_at: string | null;
  sent_at: string | null;
  graph_draft_id: string | null;
  graph_message_id: string | null;
  internet_message_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_failure_class: FailureClass | null;
  skip_reason: string | null;
  suppressed_reason: SuppressionReason | null;
  created_at: string;
  updated_at: string;
}

export interface SenderAccount {
  id: string;
  mailbox_address: string;
  display_name: string | null;
  tenant_id: string | null;
  status: SenderStatus;
  daily_limit: number;
  hourly_limit: number;
  min_interval_seconds: number;
  timezone: string;
}

export interface QueueHealth {
  queued: number;
  ready_now: number;
  in_flight: number;
  needs_reconciliation: number;
  expired_leases: number;
  oldest_available_at: string | null;
  sent_last_hour: number;
  sent_last_24h: number;
  open_critical_alerts: number;
  emergency_stop: boolean;
  global_send_enabled: boolean;
  production_mode: boolean;
}
