/**
 * Test fixtures: build a complete, sendable campaign in one call.
 *
 * Every safety test needs the same scaffolding (sender, allowlist, contacts,
 * compliant content, schedule, audience, approval). Duplicating that in each
 * test file is how tests drift apart and stop testing the same system.
 */
import type { Pool } from 'pg';

export interface SeedOptions {
  recipients?: string[];
  /** Addresses added to the test-mode allowlist. Defaults to all recipients. */
  allowlist?: string[];
  sendMode?: 'test' | 'production';
  hourlyLimit?: number;
  dailyLimit?: number;
  minIntervalSeconds?: number;
  emailsPerHour?: number;
  emailsPerDay?: number;
  minGapSeconds?: number;
  /** ISO weekdays 1-7. Defaults to all days, so tests are not day-of-week flaky. */
  allowedDays?: number[];
  windowStart?: string;
  windowEnd?: string;
  timezone?: string;
  targetCount?: number | null;
  approve?: boolean;
  start?: boolean;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
}

export interface SeedResult {
  campaignId: string;
  senderId: string;
  contactIds: string[];
  jobIds: string[];
}

const COMPLIANT_HTML =
  '<p>Hello {{first_name|there}},</p><p>This is a test.</p>' +
  '<p><a href="{{unsubscribe_url}}">Unsubscribe</a><br>{{postal_address}}</p>';
const COMPLIANT_TEXT =
  'Hello {{first_name|there}},\n\nThis is a test.\n\nUnsubscribe: {{unsubscribe_url}}\n{{postal_address}}';

/** Removes all campaign data. Safe: it only ever touches the campaign schema. */
export async function resetDatabase(db: Pool): Promise<void> {
  await db.query(`
    TRUNCATE
      campaign.email_job_attempts, campaign.email_jobs, campaign.send_counters,
      campaign.campaign_recipients, campaign.campaign_schedules,
      campaign.campaign_content_versions, campaign.campaigns,
      campaign.contact_list_members, campaign.contact_lists,
      campaign.import_errors, campaign.import_batches, campaign.contacts,
      campaign.suppressions, campaign.test_recipients, campaign.sender_accounts,
      campaign.alerts, campaign.audit_events, campaign.app_profiles
    RESTART IDENTITY CASCADE
  `);
  await db.query(`
    UPDATE campaign.system_controls
       SET emergency_stop = false, emergency_stop_reason = NULL,
           emergency_stop_at = NULL, emergency_stop_by = NULL,
           global_send_enabled = true, production_mode = false
     WHERE id = true
  `);
  await db.query(`
    UPDATE campaign.compliance_settings
       SET org_name = 'Test Org',
           postal_address = '123 Test Street, Testville ON A1A 1A1',
           app_base_url = 'https://campaigns.test.local'
     WHERE id = true
  `);
}

export async function seedCampaign(db: Pool, opts: SeedOptions = {}): Promise<SeedResult> {
  const recipients = opts.recipients ?? ['alice@example.com', 'bob@example.com'];
  const allowlist = opts.allowlist ?? recipients;

  const { rows: senderRows } = await db.query<{ id: string }>(
    `INSERT INTO campaign.sender_accounts
       (mailbox_address, display_name, timezone, hourly_limit, daily_limit, min_interval_seconds, tenant_id)
     VALUES ($1, 'Test Sender', $2, $3, $4, $5, 'test-tenant-id')
     RETURNING id`,
    [
      `campaigns+${Date.now()}@example.com`,
      opts.timezone ?? 'UTC',
      opts.hourlyLimit ?? 1000,
      opts.dailyLimit ?? 10000,
      opts.minIntervalSeconds ?? 0,
    ],
  );
  const senderId = senderRows[0]!.id;

  for (const email of allowlist) {
    await db.query(
      `INSERT INTO campaign.test_recipients (email_canonical) VALUES (campaign.canonical_email($1))
       ON CONFLICT DO NOTHING`,
      [email],
    );
  }

  const contactIds: string[] = [];
  for (const [i, email] of recipients.entries()) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO campaign.contacts (email, first_name, last_name, company)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [email, `First${i}`, `Last${i}`, `Company${i}`],
    );
    contactIds.push(rows[0]!.id);
  }

  const { rows: campaignRows } = await db.query<{ id: string }>(
    `INSERT INTO campaign.campaigns (name, sender_account_id, send_mode, target_count)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      `Test Campaign ${Date.now()}`,
      senderId,
      opts.sendMode ?? 'test',
      opts.targetCount ?? null,
    ],
  );
  const campaignId = campaignRows[0]!.id;

  await db.query('SELECT campaign.set_campaign_content($1, $2, $3, $4)', [
    campaignId,
    opts.subject ?? 'Hello {{first_name}}',
    opts.bodyHtml ?? COMPLIANT_HTML,
    opts.bodyText ?? COMPLIANT_TEXT,
  ]);

  await db.query(
    `INSERT INTO campaign.campaign_schedules
       (campaign_id, timezone, allowed_days, window_start, window_end,
        emails_per_hour, emails_per_day, min_gap_seconds)
     VALUES ($1, $2, $3::smallint[], $4, $5, $6, $7, $8)`,
    [
      campaignId,
      opts.timezone ?? 'UTC',
      opts.allowedDays ?? [1, 2, 3, 4, 5, 6, 7],
      opts.windowStart ?? '00:00',
      opts.windowEnd ?? '23:59',
      opts.emailsPerHour ?? 1000,
      opts.emailsPerDay ?? 10000,
      opts.minGapSeconds ?? 0,
    ],
  );

  for (const [i, contactId] of contactIds.entries()) {
    await db.query(
      `INSERT INTO campaign.campaign_recipients (campaign_id, contact_id, position)
       VALUES ($1, $2, $3)`,
      [campaignId, contactId, i + 1],
    );
  }

  if (opts.approve !== false) {
    await db.query('SELECT campaign.approve_campaign($1, $2)', [campaignId, 'seeded by tests']);
  }
  await db.query('SELECT * FROM campaign.materialize_campaign_jobs($1)', [campaignId]);
  if (opts.start !== false && opts.approve !== false) {
    await db.query('SELECT campaign.start_campaign($1)', [campaignId]);
  }

  const { rows: jobRows } = await db.query<{ id: string }>(
    'SELECT id FROM campaign.email_jobs WHERE campaign_id = $1 ORDER BY priority',
    [campaignId],
  );

  return { campaignId, senderId, contactIds, jobIds: jobRows.map((r) => r.id) };
}

export async function jobStatuses(db: Pool, campaignId: string): Promise<Record<string, number>> {
  const { rows } = await db.query<{ status: string; count: string }>(
    'SELECT status::text AS status, count(*)::text AS count FROM campaign.email_jobs WHERE campaign_id = $1 GROUP BY 1',
    [campaignId],
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
}

export async function getJob(db: Pool, jobId: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query('SELECT * FROM campaign.email_jobs WHERE id = $1', [jobId]);
  return rows[0] as Record<string, unknown>;
}

export async function denialReason(db: Pool, jobId: string): Promise<string | null> {
  const { rows } = await db.query<{ reason: string | null }>(
    'SELECT campaign.send_denial_reason($1) AS reason',
    [jobId],
  );
  return rows[0]?.reason ?? null;
}

/**
 * Drive a job to 'sent' through the real state machine.
 *
 * Tests cannot shortcut straight to 'sent' -- the transition trigger refuses
 * queued -> sent, which is exactly the protection we want. So set-up code walks
 * the same path a worker does.
 */
export async function forceSent(db: Pool, jobId: string, workerId = 'test-worker'): Promise<void> {
  await db.query(
    `UPDATE campaign.email_jobs
        SET status = 'claimed', locked_by = $2, locked_at = now(),
            lease_expires_at = now() + interval '5 minutes'
      WHERE id = $1`,
    [jobId, workerId],
  );
  await db.query('SELECT * FROM campaign.mark_sending($1, $2)', [jobId, workerId]);
  await db.query('SELECT campaign.mark_sent($1, $2, $3)', [jobId, workerId, `test-msg-${jobId}`]);
}
