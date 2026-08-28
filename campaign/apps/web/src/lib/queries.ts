/** Read-side queries. All run as the acting user, so RLS applies. */
import 'server-only';
import { asUser } from './db';
import type { Session } from './auth';

export interface CampaignProgress {
  campaign_id: string;
  name: string;
  status: string;
  send_mode: string;
  approved_at: string | null;
  started_at: string | null;
  target_count: number | null;
  sender_mailbox: string;
  total_jobs: string;
  sent: string;
  remaining: string;
  retrying: string;
  in_flight: string;
  failed: string;
  suppressed: string;
  cancelled: string;
  skipped: string;
  needs_reconciliation: string;
  bounced: string;
  last_sent_at: string | null;
  in_window: boolean;
  next_window_open: string | null;
}

export async function listCampaigns(session: Session): Promise<CampaignProgress[]> {
  return asUser(session.userId, async (client) => {
    const { rows } = await client.query<CampaignProgress>(
      'SELECT * FROM campaign.campaign_progress ORDER BY started_at DESC NULLS LAST, name',
    );
    return rows;
  });
}

export async function getCampaign(
  session: Session,
  id: string,
): Promise<{
  progress: CampaignProgress | null;
  campaign: Record<string, unknown> | null;
  schedule: Record<string, unknown> | null;
  content: Record<string, unknown> | null;
  complianceProblems: string[];
}> {
  return asUser(session.userId, async (client) => {
    const [progress, campaign, schedule, content, compliance] = await Promise.all([
      client.query<CampaignProgress>('SELECT * FROM campaign.campaign_progress WHERE campaign_id = $1', [id]),
      client.query('SELECT * FROM campaign.campaigns WHERE id = $1', [id]),
      client.query('SELECT * FROM campaign.campaign_schedules WHERE campaign_id = $1', [id]),
      client.query(
        `SELECT v.* FROM campaign.campaign_content_versions v
           JOIN campaign.campaigns c ON c.current_version_id = v.id
          WHERE c.id = $1`,
        [id],
      ),
      client.query<{ problems: string[] }>(
        'SELECT campaign.compliance_problems($1) AS problems',
        [id],
      ),
    ]);
    return {
      progress: progress.rows[0] ?? null,
      campaign: (campaign.rows[0] as Record<string, unknown>) ?? null,
      schedule: (schedule.rows[0] as Record<string, unknown>) ?? null,
      content: (content.rows[0] as Record<string, unknown>) ?? null,
      complianceProblems: compliance.rows[0]?.problems ?? [],
    };
  });
}

export interface JobRow {
  id: string;
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  status: string;
  effective_state: string;
  current_denial_reason: string | null;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  sent_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  skip_reason: string | null;
  suppressed_reason: string | null;
  graph_message_id: string | null;
}

export async function listJobs(
  session: Session,
  campaignId: string,
  filter?: string,
  limit = 100,
): Promise<JobRow[]> {
  return asUser(session.userId, async (client) => {
    const clauses = ['campaign_id = $1'];
    const params: unknown[] = [campaignId];

    if (filter && filter !== 'all') {
      const groups: Record<string, string> = {
        sent: "status = 'sent'",
        failed: "status IN ('failed_permanent', 'bounced', 'complained')",
        retrying: "status = 'queued' AND attempt_count > 0",
        pending: "status IN ('pending', 'queued') AND attempt_count = 0",
        suppressed: "status = 'suppressed'",
        skipped: "status IN ('skipped', 'cancelled')",
        attention: "status = 'needs_reconciliation'",
      };
      if (groups[filter]) clauses.push(groups[filter]!);
    }

    params.push(limit);
    const { rows } = await client.query<JobRow>(
      `SELECT * FROM campaign.job_monitor
        WHERE ${clauses.join(' AND ')}
        ORDER BY sent_at DESC NULLS LAST, created_at
        LIMIT $${params.length}`,
      params,
    );
    return rows;
  });
}

export async function jobAttempts(session: Session, jobId: string) {
  return asUser(session.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT attempt_no, worker_id, started_at, finished_at, duration_ms, outcome,
              http_status, graph_request_id, failure_class, error_code, error_message,
              retry_after_seconds
         FROM campaign.email_job_attempts WHERE job_id = $1 ORDER BY attempt_no`,
      [jobId],
    );
    return rows as Array<Record<string, unknown>>;
  });
}

export async function queueHealth(session: Session) {
  return asUser(session.userId, async (client) => {
    const { rows } = await client.query('SELECT * FROM campaign.queue_health');
    return rows[0] as Record<string, unknown>;
  });
}

export async function senderCapacity(session: Session) {
  return asUser(session.userId, async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM campaign.sender_capacity ORDER BY mailbox_address',
    );
    return rows as Array<Record<string, unknown>>;
  });
}

export async function openAlerts(session: Session) {
  return asUser(session.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, created_at, severity::text AS severity, alert_key, title, detail,
              campaign_id, acknowledged_at
         FROM campaign.alerts WHERE resolved_at IS NULL
        ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
                 created_at DESC
        LIMIT 50`,
    );
    return rows as Array<Record<string, unknown>>;
  });
}

export async function listContacts(session: Session, search?: string, limit = 100) {
  return asUser(session.userId, async (client) => {
    const params: unknown[] = [limit];
    let where = 'c.deleted_at IS NULL';
    if (search) {
      params.unshift(`%${search}%`);
      where += ` AND (c.email::text ILIKE $1 OR c.first_name ILIKE $1
                      OR c.last_name ILIKE $1 OR c.company ILIKE $1)`;
    }
    const { rows } = await client.query(
      `SELECT c.id, c.email::text AS email, c.first_name, c.last_name, c.company,
              c.status::text AS status, c.source, c.created_at,
              campaign.is_suppressed(c.email::text) AS suppressed
         FROM campaign.contacts c
        WHERE ${where}
        ORDER BY c.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows as Array<Record<string, unknown>>;
  });
}

export async function contactCount(session: Session) {
  return asUser(session.userId, async (client) => {
    const { rows } = await client.query<{ total: string; suppressed: string }>(
      `SELECT (SELECT count(*)::text FROM campaign.contacts WHERE deleted_at IS NULL) AS total,
              (SELECT count(*)::text FROM campaign.suppressions WHERE revoked_at IS NULL) AS suppressed`,
    );
    return rows[0]!;
  });
}

export async function listSuppressions(session: Session, limit = 200) {
  return asUser(session.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, email_canonical::text AS email, domain::text AS domain,
              reason::text AS reason, scope::text AS scope, source, notes,
              created_at, revoked_at, revoke_reason
         FROM campaign.suppressions
        ORDER BY revoked_at NULLS FIRST, created_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows as Array<Record<string, unknown>>;
  });
}

export async function listSenders(session: Session) {
  return asUser(session.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT s.*, c.hourly_remaining, c.daily_remaining, c.sent_today, c.sent_this_hour
         FROM campaign.sender_accounts s
         JOIN campaign.sender_capacity c ON c.sender_account_id = s.id
        ORDER BY s.mailbox_address`,
    );
    return rows as Array<Record<string, unknown>>;
  });
}

export async function listTestRecipients(session: Session) {
  return asUser(session.userId, async (client) => {
    const { rows } = await client.query(
      'SELECT id, email_canonical::text AS email, note FROM campaign.test_recipients ORDER BY email_canonical',
    );
    return rows as Array<Record<string, unknown>>;
  });
}

export async function complianceSettings(session: Session) {
  return asUser(session.userId, async (client) => {
    const { rows } = await client.query(
      'SELECT org_name, postal_address, reply_to::text AS reply_to, app_base_url FROM campaign.compliance_settings WHERE id',
    );
    return rows[0] as Record<string, unknown>;
  });
}

export async function listAudit(
  session: Session,
  opts: { action?: string; campaignId?: string; limit?: number } = {},
) {
  return asUser(session.userId, async (client) => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.action) {
      params.push(`${opts.action}%`);
      clauses.push(`action LIKE $${params.length}`);
    }
    if (opts.campaignId) {
      params.push(opts.campaignId);
      clauses.push(`campaign_id = $${params.length}`);
    }
    params.push(opts.limit ?? 200);
    const { rows } = await client.query(
      `SELECT id, occurred_at, actor_type::text AS actor_type, actor_id, actor_label,
              action, entity_type, entity_id, campaign_id, job_id, reason_code,
              before_state, after_state, metadata
         FROM campaign.audit_events
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows as Array<Record<string, unknown>>;
  });
}

export async function listContactLists(session: Session) {
  return asUser(session.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT l.id, l.name, l.description,
              (SELECT count(*)::text FROM campaign.contact_list_members m WHERE m.list_id = l.id) AS members
         FROM campaign.contact_lists l
        WHERE l.archived_at IS NULL
        ORDER BY l.name`,
    );
    return rows as Array<Record<string, unknown>>;
  });
}
