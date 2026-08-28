/**
 * Operator controls: pause, resume, stop, emergency stop, suppression, and the
 * compliance gate. These are the levers a human pulls when something is wrong,
 * so each one is tested for the property the operator is relying on.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { forceSent, jobStatuses, resetDatabase, seedCampaign, denialReason } from '@campaign/testing';
import { closeTestDb, getTestDb } from '../helpers.js';
import type { Pool } from '@campaign/core';

let db: Pool;

beforeEach(async () => {
  db = await getTestDb();
  await resetDatabase(db);
});

afterAll(async () => {
  await closeTestDb();
});

describe('pause and resume', () => {
  it('stops sending immediately and restores exactly the same jobs on resume', async () => {
    const { campaignId, jobIds } = await seedCampaign(db, {
      recipients: ['a@example.com', 'b@example.com', 'c@example.com'],
    });

    await db.query("SELECT campaign.pause_campaign($1, 'operator test')", [campaignId]);
    expect(await denialReason(db, jobIds[0]!)).toBe('campaign_paused');

    const claimed = await db.query('SELECT id FROM campaign.claim_email_jobs($1, 10, 60)', ['w']);
    expect(claimed.rows).toHaveLength(0);

    await db.query('SELECT campaign.resume_campaign($1)', [campaignId]);
    expect(await denialReason(db, jobIds[0]!)).toBeNull();

    const after = await db.query('SELECT id FROM campaign.claim_email_jobs($1, 10, 60)', ['w']);
    expect(after.rows).toHaveLength(3);
    expect(await jobStatuses(db, campaignId)).toEqual({ claimed: 3 });
  });

  it('refuses to resume a campaign whose approval was revoked', async () => {
    const { campaignId } = await seedCampaign(db);
    await db.query("SELECT campaign.pause_campaign($1, 'test')", [campaignId]);
    await db.query(
      'UPDATE campaign.campaigns SET approved_at = NULL, approved_content_hash = NULL WHERE id = $1',
      [campaignId],
    );
    await expect(db.query('SELECT campaign.resume_campaign($1)', [campaignId])).rejects.toThrow(
      /lost its approval/,
    );
  });

  it('refuses to pause a campaign that is not running', async () => {
    const { campaignId } = await seedCampaign(db, { start: false });
    await expect(
      db.query("SELECT campaign.pause_campaign($1, 'x')", [campaignId]),
    ).rejects.toThrow(/only a running campaign/);
  });
});

describe('stop', () => {
  it('cancels everything unsent and is final', async () => {
    const { campaignId, jobIds } = await seedCampaign(db, {
      recipients: ['a@example.com', 'b@example.com', 'c@example.com'],
    });
    await forceSent(db, jobIds[0]!);

    await db.query("SELECT campaign.stop_campaign($1, 'operator test')", [campaignId]);

    // The already-sent email stays sent; the rest are cancelled.
    expect(await jobStatuses(db, campaignId)).toEqual({ sent: 1, cancelled: 2 });

    const claimed = await db.query('SELECT id FROM campaign.claim_email_jobs($1, 10, 60)', ['w']);
    expect(claimed.rows).toHaveLength(0);
  });

  it('leaves an in-flight send alone rather than losing the record of it', async () => {
    const { campaignId, jobIds } = await seedCampaign(db, { recipients: ['a@example.com'] });
    await db.query(
      `UPDATE campaign.email_jobs SET status='claimed', locked_by='w', locked_at=now(),
              lease_expires_at = now() + interval '5 minutes' WHERE id = $1`,
      [jobIds[0]!],
    );
    await db.query('SELECT * FROM campaign.mark_sending($1, $2)', [jobIds[0]!, 'w']);

    await db.query("SELECT campaign.stop_campaign($1, 'test')", [campaignId]);

    // 'sending' is untouched: that request may already have been delivered.
    expect(await jobStatuses(db, campaignId)).toEqual({ sending: 1 });
  });

  it('is idempotent', async () => {
    const { campaignId } = await seedCampaign(db);
    await db.query("SELECT campaign.stop_campaign($1, 'once')", [campaignId]);
    const { rows } = await db.query<{ stop_campaign: string }>(
      "SELECT campaign.stop_campaign($1, 'twice') AS stop_campaign",
      [campaignId],
    );
    expect(rows[0]!.stop_campaign).toBe('stopped');
  });
});

describe('emergency stop', () => {
  it('halts every campaign at once, and releasing it restores them', async () => {
    const first = await seedCampaign(db, { recipients: ['a@example.com'] });
    const second = await seedCampaign(db, { recipients: ['b@example.com'] });

    await db.query("SELECT campaign.set_emergency_stop(true, 'suspected bad list')");

    const claimed = await db.query('SELECT id FROM campaign.claim_email_jobs($1, 50, 60)', ['w']);
    expect(claimed.rows).toHaveLength(0);
    expect(await denialReason(db, first.jobIds[0]!)).toBe('emergency_stop_engaged');
    expect(await denialReason(db, second.jobIds[0]!)).toBe('emergency_stop_engaged');

    // Nothing was rewritten, so nothing has to be restored.
    expect(await jobStatuses(db, first.campaignId)).toEqual({ queued: 1 });

    await db.query('SELECT campaign.set_emergency_stop(false)');
    const after = await db.query('SELECT id FROM campaign.claim_email_jobs($1, 50, 60)', ['w']);
    expect(after.rows).toHaveLength(2);
  });

  it('records who engaged it, when, and why', async () => {
    await db.query("SELECT campaign.set_emergency_stop(true, 'wrong list uploaded')");
    const { rows } = await db.query<{ reason: string; at: string }>(
      'SELECT emergency_stop_reason AS reason, emergency_stop_at::text AS at FROM campaign.system_controls',
    );
    expect(rows[0]!.reason).toBe('wrong list uploaded');
    expect(rows[0]!.at).toBeTruthy();

    const audit = await db.query<{ action: string }>(
      "SELECT action FROM campaign.audit_events WHERE action = 'system.emergency_stop_engaged'",
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('raises a critical alert that resolves when released', async () => {
    await db.query("SELECT campaign.set_emergency_stop(true, 'test')");
    let alerts = await db.query(
      "SELECT 1 FROM campaign.alerts WHERE alert_key = 'emergency_stop' AND resolved_at IS NULL",
    );
    expect(alerts.rows).toHaveLength(1);

    await db.query('SELECT campaign.set_emergency_stop(false)');
    alerts = await db.query(
      "SELECT 1 FROM campaign.alerts WHERE alert_key = 'emergency_stop' AND resolved_at IS NULL",
    );
    expect(alerts.rows).toHaveLength(0);
  });
});

describe('sender pause', () => {
  it('stops only the affected mailbox', async () => {
    const first = await seedCampaign(db, { recipients: ['a@example.com'] });
    const second = await seedCampaign(db, { recipients: ['b@example.com'] });

    await db.query("SELECT campaign.set_sender_status($1, 'paused', 'investigating bounces')", [
      first.senderId,
    ]);

    expect(await denialReason(db, first.jobIds[0]!)).toBe('sender_paused');
    expect(await denialReason(db, second.jobIds[0]!)).toBeNull();
  });

  it('un-parks waiting jobs when the mailbox is reactivated', async () => {
    const { senderId, jobIds } = await seedCampaign(db, { recipients: ['a@example.com'] });
    await db.query("SELECT campaign.set_sender_status($1, 'paused', 'test')", [senderId]);

    // A claim attempt parks the job with the reason.
    await db.query('SELECT id FROM campaign.claim_email_jobs($1, 10, 60)', ['w']);
    let job = await db.query<{ skip_reason: string }>(
      'SELECT skip_reason FROM campaign.email_jobs WHERE id = $1',
      [jobIds[0]!],
    );
    expect(job.rows[0]!.skip_reason).toBe('sender_paused');

    await db.query("SELECT campaign.set_sender_status($1, 'active', NULL)", [senderId]);
    job = await db.query<{ skip_reason: string }>(
      'SELECT skip_reason FROM campaign.email_jobs WHERE id = $1',
      [jobIds[0]!],
    );
    expect(job.rows[0]!.skip_reason).toBeNull();
    expect(await denialReason(db, jobIds[0]!)).toBeNull();
  });
});

describe('suppression', () => {
  it('takes a queued job out of the queue in the same transaction', async () => {
    const { campaignId } = await seedCampaign(db, {
      recipients: ['keep@example.com', 'drop@example.com'],
    });

    await db.query("SELECT campaign.add_suppression('drop@example.com', 'unsubscribe')");

    const { rows } = await db.query<{ recipient_email: string; status: string }>(
      `SELECT recipient_email::text AS recipient_email, status::text AS status
         FROM campaign.email_jobs WHERE campaign_id = $1 ORDER BY recipient_email`,
      [campaignId],
    );
    expect(rows).toEqual([
      { recipient_email: 'drop@example.com', status: 'suppressed' },
      { recipient_email: 'keep@example.com', status: 'queued' },
    ]);
  });

  it('reaches a job already leased by a worker', async () => {
    const { campaignId } = await seedCampaign(db, { recipients: ['drop@example.com'] });
    await db.query('SELECT id FROM campaign.claim_email_jobs($1, 10, 300)', ['w']);
    expect(await jobStatuses(db, campaignId)).toEqual({ claimed: 1 });

    await db.query("SELECT campaign.add_suppression('drop@example.com', 'unsubscribe')");
    expect(await jobStatuses(db, campaignId)).toEqual({ suppressed: 1 });
  });

  it('is idempotent', async () => {
    await seedCampaign(db, { recipients: ['x@example.com'] });
    const a = await db.query<{ add_suppression: string }>(
      "SELECT campaign.add_suppression('x@example.com', 'manual') AS add_suppression",
    );
    const b = await db.query<{ add_suppression: string }>(
      "SELECT campaign.add_suppression('x@example.com', 'manual') AS add_suppression",
    );
    expect(b.rows[0]!.add_suppression).toBe(a.rows[0]!.add_suppression);
  });

  // An unsubscribe is a legal request, not an operational preference.
  it('refuses to revoke an unsubscribe or a spam complaint', async () => {
    const { rows } = await db.query<{ id: string }>(
      "SELECT campaign.add_suppression('x@example.com', 'unsubscribe') AS id",
    );
    await expect(
      db.query("SELECT campaign.revoke_suppression($1, 'they asked us to')", [rows[0]!.id]),
    ).rejects.toThrow(/cannot be revoked/);
  });

  it('allows revoking a manual suppression, with a recorded reason', async () => {
    const { rows } = await db.query<{ id: string }>(
      "SELECT campaign.add_suppression('y@example.com', 'manual') AS id",
    );
    await db.query("SELECT campaign.revoke_suppression($1, 'added in error')", [rows[0]!.id]);
    const check = await db.query<{ revoke_reason: string }>(
      'SELECT revoke_reason FROM campaign.suppressions WHERE id = $1',
      [rows[0]!.id],
    );
    expect(check.rows[0]!.revoke_reason).toBe('added in error');
  });

  it('honours a one-click unsubscribe from the public endpoint', async () => {
    const { campaignId } = await seedCampaign(db, { recipients: ['pub@example.com'] });
    await db.query("SELECT campaign.public_unsubscribe('pub@example.com', $1)", [campaignId]);
    expect(await jobStatuses(db, campaignId)).toEqual({ suppressed: 1 });
  });
});

describe('the compliance gate', () => {
  it('blocks approval when the body has no unsubscribe mechanism', async () => {
    const { campaignId } = await seedCampaign(db, {
      approve: false,
      start: false,
      bodyHtml: '<p>Buy things. {{postal_address}}</p>',
      bodyText: 'Buy things. {{postal_address}}',
    });
    await expect(
      db.query("SELECT campaign.approve_campaign($1, 'x')", [campaignId]),
    ).rejects.toThrow(/missing_unsubscribe/);
  });

  it('blocks approval when the body has no postal address', async () => {
    const { campaignId } = await seedCampaign(db, {
      approve: false,
      start: false,
      bodyHtml: '<p>Hi. <a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
      bodyText: 'Hi. Unsubscribe: {{unsubscribe_url}}',
    });
    await expect(
      db.query("SELECT campaign.approve_campaign($1, 'x')", [campaignId]),
    ).rejects.toThrow(/missing_postal_address/);
  });

  it('blocks approval of a campaign with no recipients', async () => {
    const { campaignId } = await seedCampaign(db, { approve: false, start: false });
    await db.query('DELETE FROM campaign.campaign_recipients WHERE campaign_id = $1', [campaignId]);
    await expect(
      db.query("SELECT campaign.approve_campaign($1, 'x')", [campaignId]),
    ).rejects.toThrow(/no_recipients/);
  });

  // The failure the gate alone did not catch: the placeholder is present but
  // nothing is configured to fill it, so the link would render empty.
  it('refuses to materialize when no unsubscribe base URL is configured', async () => {
    await db.query('UPDATE campaign.compliance_settings SET app_base_url = NULL WHERE id');
    await expect(seedCampaign(db, { recipients: ['a@example.com'] })).rejects.toThrow(
      /app_base_url must be set/,
    );
  });
});

describe('the audit trail', () => {
  it('records every job state transition', async () => {
    const { campaignId, jobIds } = await seedCampaign(db, { recipients: ['a@example.com'] });
    await forceSent(db, jobIds[0]!);

    const { rows } = await db.query<{ before: string; after: string }>(
      `SELECT before_state ->> 'status' AS before, after_state ->> 'status' AS after
         FROM campaign.audit_events
        WHERE action = 'email_job.transition' AND job_id = $1
        ORDER BY id`,
      [jobIds[0]!],
    );
    const path = rows.map((r) => `${r.before}->${r.after}`);
    expect(path).toContain('pending->queued');
    expect(path).toContain('queued->claimed');
    expect(path).toContain('claimed->sending');
    expect(path).toContain('sending->sent');
    void campaignId;
  });

  it('records an authorization refusal with its reason code', async () => {
    await seedCampaign(db, { recipients: ['a@example.com'] });
    await db.query("SELECT campaign.set_emergency_stop(true, 'test')");
    await db.query('SELECT id FROM campaign.claim_email_jobs($1, 10, 60)', ['w']);

    const { rows } = await db.query<{ reason_code: string }>(
      "SELECT reason_code FROM campaign.audit_events WHERE action = 'claim.refused'",
    );
    expect(rows[0]!.reason_code).toBe('emergency_stop_engaged');
  });

  it('cannot be modified or deleted', async () => {
    await seedCampaign(db, { recipients: ['a@example.com'] });
    await expect(
      db.query("UPDATE campaign.audit_events SET action = 'tampered' WHERE id > 0"),
    ).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM campaign.audit_events WHERE id > 0')).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('content versions', () => {
  it('are immutable once written', async () => {
    const { campaignId } = await seedCampaign(db);
    await expect(
      db.query(
        "UPDATE campaign.campaign_content_versions SET subject_template = 'changed' WHERE campaign_id = $1",
        [campaignId],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('are created fresh on every edit, so an approval always has its exact content', async () => {
    const { campaignId } = await seedCampaign(db, { approve: false, start: false });
    await db.query('SELECT campaign.set_campaign_content($1, $2, $3, $4)', [
      campaignId, 'v2', '<p>v2 {{unsubscribe_url}} {{postal_address}}</p>', 'v2',
    ]);
    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM campaign.campaign_content_versions WHERE campaign_id = $1',
      [campaignId],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });
});
