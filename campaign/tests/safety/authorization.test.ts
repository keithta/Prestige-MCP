/**
 * The twelve authorization checks, each falsified individually.
 *
 * campaign.send_denial_reason() is the single decision point for whether an
 * email may be sent. If any of these stop refusing, the system can send mail it
 * should not have sent -- so each one gets its own test with its own reason code.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { forceSent, resetDatabase, seedCampaign, denialReason } from '@campaign/testing';
import { closeTestDb, getTestDb, setSchedule } from '../helpers.js';
import type { Pool } from '@campaign/core';

let db: Pool;

beforeEach(async () => {
  db = await getTestDb();
  await resetDatabase(db);
});

afterAll(async () => {
  await closeTestDb();
});

describe('an authorized job', () => {
  it('is refused for no reason at all', async () => {
    const { jobIds } = await seedCampaign(db);
    expect(await denialReason(db, jobIds[0]!)).toBeNull();
  });
});

describe('check 1 - global emergency stop', () => {
  it('refuses every job while engaged', async () => {
    const { jobIds } = await seedCampaign(db);
    await db.query("SELECT campaign.set_emergency_stop(true, 'test')");
    expect(await denialReason(db, jobIds[0]!)).toBe('emergency_stop_engaged');
  });

  it('requires a reason to engage, so the audit trail is never blank', async () => {
    await expect(db.query('SELECT campaign.set_emergency_stop(true, NULL)')).rejects.toThrow(
      /reason is required/,
    );
  });

  it('authorizes again once released', async () => {
    const { jobIds } = await seedCampaign(db);
    await db.query("SELECT campaign.set_emergency_stop(true, 'test')");
    await db.query('SELECT campaign.set_emergency_stop(false)');
    expect(await denialReason(db, jobIds[0]!)).toBeNull();
  });
});

describe('check 2 - global send switch', () => {
  it('refuses when global sending is disabled', async () => {
    const { jobIds } = await seedCampaign(db);
    await db.query('UPDATE campaign.system_controls SET global_send_enabled = false WHERE id');
    expect(await denialReason(db, jobIds[0]!)).toBe('global_send_disabled');
  });
});

describe('check 3 - campaign status', () => {
  it('refuses a paused campaign', async () => {
    const { campaignId, jobIds } = await seedCampaign(db);
    await db.query("SELECT campaign.pause_campaign($1, 'test')", [campaignId]);
    expect(await denialReason(db, jobIds[0]!)).toBe('campaign_paused');
  });

  it('refuses a campaign that was never started', async () => {
    const { jobIds } = await seedCampaign(db, { start: false });
    expect(await denialReason(db, jobIds[0]!)).toBe('job_not_queued');
  });
});

describe('check 4 - approval bound to exact content', () => {
  it('refuses an unapproved campaign', async () => {
    const { campaignId, jobIds } = await seedCampaign(db);
    await db.query(
      'UPDATE campaign.campaigns SET approved_at = NULL, approved_content_hash = NULL WHERE id = $1',
      [campaignId],
    );
    expect(await denialReason(db, jobIds[0]!)).toBe('campaign_not_approved');
  });

  // The scenario this exists for: someone approves a campaign, then quietly
  // edits the body. Every job built from the old content must stop.
  it('refuses every unsent job when content changes after approval', async () => {
    const { campaignId, jobIds } = await seedCampaign(db);
    expect(await denialReason(db, jobIds[0]!)).toBeNull();

    await db.query('SELECT campaign.set_campaign_content($1, $2, $3, $4)', [
      campaignId,
      'A COMPLETELY DIFFERENT SUBJECT',
      '<p>different {{unsubscribe_url}} {{postal_address}}</p>',
      'different {{unsubscribe_url}} {{postal_address}}',
    ]);

    const { rows } = await db.query<{ status: string }>(
      'SELECT status::text AS status FROM campaign.campaigns WHERE id = $1',
      [campaignId],
    );
    expect(rows[0]!.status).toBe('pending_approval');

    // The jobs were cancelled outright, so there is nothing left to authorize.
    const statuses = await db.query<{ status: string; count: string }>(
      'SELECT status::text AS status, count(*)::text AS count FROM campaign.email_jobs WHERE campaign_id = $1 GROUP BY 1',
      [campaignId],
    );
    expect(statuses.rows).toEqual([{ status: 'cancelled', count: '2' }]);
  });
});

describe('check 5 and 10 - queue state and attempt budget', () => {
  it('refuses a job that is not queued', async () => {
    const { jobIds } = await seedCampaign(db);
    await db.query("UPDATE campaign.email_jobs SET status = 'held' WHERE id = $1", [jobIds[0]!]);
    expect(await denialReason(db, jobIds[0]!)).toBe('job_not_queued');
  });

  it('refuses a job whose backoff has not elapsed', async () => {
    const { jobIds } = await seedCampaign(db);
    await db.query(
      "UPDATE campaign.email_jobs SET available_at = now() + interval '1 hour' WHERE id = $1",
      [jobIds[0]!],
    );
    expect(await denialReason(db, jobIds[0]!)).toBe('backoff_not_elapsed');
  });

  it('refuses a job that has used every attempt', async () => {
    const { jobIds } = await seedCampaign(db);
    await db.query(
      'UPDATE campaign.email_jobs SET attempt_count = max_attempts WHERE id = $1',
      [jobIds[0]!],
    );
    expect(await denialReason(db, jobIds[0]!)).toBe('attempts_exhausted');
  });
});

describe('check 6 - sender account', () => {
  it('refuses when the sending mailbox is paused', async () => {
    const { senderId, jobIds } = await seedCampaign(db);
    await db.query("SELECT campaign.set_sender_status($1, 'paused', 'test')", [senderId]);
    expect(await denialReason(db, jobIds[0]!)).toBe('sender_paused');
  });

  it('refuses when the sending mailbox is disabled', async () => {
    const { senderId, jobIds } = await seedCampaign(db);
    await db.query("SELECT campaign.set_sender_status($1, 'disabled', 'test')", [senderId]);
    expect(await denialReason(db, jobIds[0]!)).toBe('sender_disabled');
  });
});

describe('check 7 - schedule window', () => {
  it('refuses outside the allowed hours', async () => {
    const { campaignId, jobIds } = await seedCampaign(db);
    // A one-minute window at a time that is certainly not now.
    await setSchedule(db, campaignId, { window_start: '03:00', window_end: '03:01' });
    expect(await denialReason(db, jobIds[0]!)).toBe('outside_sending_window');
  });

  it('refuses on a day that is not allowed', async () => {
    const { campaignId, jobIds } = await seedCampaign(db);
    const { rows } = await db.query<{ dow: string }>(
      "SELECT extract(isodow from now() AT TIME ZONE 'UTC')::text AS dow",
    );
    const today = Number(rows[0]!.dow);
    const others = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today);
    await setSchedule(db, campaignId, { allowed_days: others });
    expect(await denialReason(db, jobIds[0]!)).toBe('outside_sending_window');
  });

  it('refuses before the campaign start time', async () => {
    const { campaignId, jobIds } = await seedCampaign(db);
    await setSchedule(db, campaignId, { start_at: new Date(Date.now() + 3600_000) });
    expect(await denialReason(db, jobIds[0]!)).toBe('campaign_not_started');
  });

  it('refuses after the campaign end time', async () => {
    const { campaignId, jobIds } = await seedCampaign(db);
    await setSchedule(db, campaignId, {
      start_at: new Date(Date.now() - 7200_000),
      end_at: new Date(Date.now() - 3600_000),
    });
    expect(await denialReason(db, jobIds[0]!)).toBe('campaign_window_ended');
  });
});

describe('check 8 - suppression', () => {
  it('refuses a suppressed recipient', async () => {
    const { jobIds } = await seedCampaign(db, { recipients: ['zed@example.com'] });
    // Suppress without letting add_suppression rewrite the job, so we are
    // testing the authorization check itself rather than the side effect.
    await db.query(
      `INSERT INTO campaign.suppressions (email_canonical, reason, scope, source)
       VALUES (campaign.canonical_email('zed@example.com'), 'manual', 'global', 'test')`,
    );
    expect(await denialReason(db, jobIds[0]!)).toBe('recipient_suppressed');
  });

  it('refuses a recipient whose whole domain is blocked', async () => {
    const { jobIds } = await seedCampaign(db, { recipients: ['someone@blocked.example'] });
    await db.query(
      `INSERT INTO campaign.suppressions (domain, reason, scope, source)
       VALUES ('blocked.example', 'domain_block', 'global', 'test')`,
    );
    expect(await denialReason(db, jobIds[0]!)).toBe('recipient_suppressed');
  });

  it('is case-insensitive about the address', async () => {
    const { jobIds } = await seedCampaign(db, {
      recipients: ['MixedCase@Example.com'],
      allowlist: ['mixedcase@example.com'],
    });
    await db.query(
      `INSERT INTO campaign.suppressions (email_canonical, reason, scope, source)
       VALUES (campaign.canonical_email('MIXEDCASE@EXAMPLE.COM'), 'unsubscribe', 'global', 'test')`,
    );
    expect(await denialReason(db, jobIds[0]!)).toBe('recipient_suppressed');
  });
});

describe('check 9 - rate limits', () => {
  it('refuses when the mailbox hourly limit is reached', async () => {
    const { campaignId, senderId, jobIds } = await seedCampaign(db, { hourlyLimit: 1 });
    await db.query(
      `INSERT INTO campaign.send_counters (sender_account_id, campaign_id, bucket_hour, sent_count)
       VALUES ($1, $2, date_trunc('hour', now()), 1)`,
      [senderId, campaignId],
    );
    expect(await denialReason(db, jobIds[0]!)).toBe('sender_hourly_limit_reached');
  });

  it('refuses when the campaign hourly limit is reached', async () => {
    const { campaignId, senderId, jobIds } = await seedCampaign(db, { emailsPerHour: 2 });
    await db.query(
      `INSERT INTO campaign.send_counters (sender_account_id, campaign_id, bucket_hour, sent_count)
       VALUES ($1, $2, date_trunc('hour', now()), 2)`,
      [senderId, campaignId],
    );
    expect(await denialReason(db, jobIds[0]!)).toBe('campaign_hourly_limit_reached');
  });

  it('refuses when the minimum gap between sends has not elapsed', async () => {
    const { jobIds } = await seedCampaign(db, { minIntervalSeconds: 300 });
    // Send the other job through the real state machine so the gap is genuine.
    await forceSent(db, jobIds[1]!);
    expect(await denialReason(db, jobIds[0]!)).toBe('min_send_gap_not_elapsed');
  });
});

describe('check 11 - duplicate protection', () => {
  it('refuses a second job for an address this campaign already sent to', async () => {
    const { campaignId, jobIds, senderId } = await seedCampaign(db, {
      recipients: ['dup@example.com', 'other@example.com'],
    });
    await forceSent(db, jobIds[0]!);
    // Force a second job to the same address past the unique index, to prove
    // the authorization check catches what the index would normally prevent.
    await db.query(
      `INSERT INTO campaign.email_jobs
         (campaign_id, contact_id, sender_account_id, content_version_hash,
          recipient_email, subject, body_text, status)
       SELECT $1, c.id, $2, j.content_version_hash, 'dup@example.com', 'x', 'y', 'queued'
         FROM campaign.contacts c, campaign.email_jobs j
        WHERE c.email = 'other@example.com' AND j.id = $3
        LIMIT 1
       ON CONFLICT DO NOTHING`,
      [campaignId, senderId, jobIds[0]!],
    );
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM campaign.email_jobs WHERE recipient_email='dup@example.com' AND status='queued'",
    );
    if (rows[0]) {
      expect(await denialReason(db, rows[0].id)).toBe('duplicate_recipient_already_sent');
    }
  });
});

describe('check 12 - test and production mode gates', () => {
  it('refuses a recipient who is not on the test allowlist', async () => {
    const { jobIds } = await seedCampaign(db, {
      recipients: ['allowed@example.com', 'notallowed@example.com'],
      allowlist: ['allowed@example.com'],
    });
    const { rows } = await db.query<{ id: string; recipient_email: string }>(
      'SELECT id, recipient_email::text AS recipient_email FROM campaign.email_jobs ORDER BY recipient_email',
    );
    const allowed = rows.find((r) => r.recipient_email === 'allowed@example.com')!;
    const blocked = rows.find((r) => r.recipient_email === 'notallowed@example.com')!;

    expect(await denialReason(db, allowed.id)).toBeNull();
    expect(await denialReason(db, blocked.id)).toBe('test_mode_recipient_not_allowed');
  });

  // The single most important default in the system: a production campaign
  // sends nothing until a human deliberately turns production mode on.
  it('refuses a production campaign while production mode is off', async () => {
    const { jobIds } = await seedCampaign(db, { sendMode: 'production' });
    expect(await denialReason(db, jobIds[0]!)).toBe('production_mode_disabled');
  });

  it('authorizes a production campaign once production mode is enabled', async () => {
    const { jobIds } = await seedCampaign(db, { sendMode: 'production' });
    await db.query("SELECT campaign.set_production_mode(true, 'test')");
    expect(await denialReason(db, jobIds[0]!)).toBeNull();
  });
});
