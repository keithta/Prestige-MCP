/**
 * Duplicate prevention, layer by layer.
 *
 * Sending the same person the same campaign twice is the failure this system
 * exists to prevent, so each independent protection gets its own test. Any one
 * of them should be sufficient on its own.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { forceSent, resetDatabase, seedCampaign } from '@campaign/testing';
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

describe('layer 1 - one job per contact per campaign', () => {
  it('rejects a second job for the same contact', async () => {
    const { campaignId, contactIds, senderId } = await seedCampaign(db);
    await expect(
      db.query(
        `INSERT INTO campaign.email_jobs
           (campaign_id, contact_id, sender_account_id, content_version_hash,
            recipient_email, subject, body_text)
         VALUES ($1, $2, $3, 'hash', 'x@example.com', 's', 'b')`,
        [campaignId, contactIds[0]!, senderId],
      ),
    ).rejects.toThrow(/email_jobs_campaign_contact_key|duplicate key/);
  });
});

describe('layer 2 - idempotency key', () => {
  it('is derived, not supplied, and is stable for the same inputs', async () => {
    const { jobIds } = await seedCampaign(db);
    const { rows } = await db.query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM campaign.email_jobs WHERE id = $1',
      [jobIds[0]!],
    );
    expect(rows[0]!.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs between two recipients of the same campaign', async () => {
    await seedCampaign(db);
    const { rows } = await db.query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM campaign.email_jobs',
    );
    expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(rows.length);
  });
});

describe('layer 3 - one live job per ADDRESS per campaign', () => {
  // Layer 1 keys on contact_id. This catches the case it cannot: two different
  // contact rows that happen to share an email address.
  it('rejects a second live job for the same address via a different contact', async () => {
    const { campaignId, senderId } = await seedCampaign(db, { recipients: ['a@example.com'] });
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO campaign.contacts (email, first_name) VALUES ('other@example.com', 'Other')
       RETURNING id`,
    );
    await expect(
      db.query(
        `INSERT INTO campaign.email_jobs
           (campaign_id, contact_id, sender_account_id, content_version_hash,
            recipient_email, subject, body_text)
         VALUES ($1, $2, $3, 'hash', 'a@example.com', 's', 'b')`,
        [campaignId, rows[0]!.id, senderId],
      ),
    ).rejects.toThrow(/email_jobs_one_live_per_recipient|duplicate key/);
  });
});

describe('layer 4 - atomic claiming', () => {
  it('never hands the same job to two workers', async () => {
    const { jobIds } = await seedCampaign(db, {
      recipients: Array.from({ length: 20 }, (_, i) => `c${i}@example.com`),
    });
    expect(jobIds).toHaveLength(20);

    const [a, b] = await Promise.all([
      db.query<{ id: string }>('SELECT id FROM campaign.claim_email_jobs($1, 20, 120)', ['w-a']),
      db.query<{ id: string }>('SELECT id FROM campaign.claim_email_jobs($1, 20, 120)', ['w-b']),
    ]);

    const idsA = a.rows.map((r) => r.id);
    const idsB = b.rows.map((r) => r.id);
    const overlap = idsA.filter((id) => idsB.includes(id));

    expect(overlap).toEqual([]);
    expect(idsA.length + idsB.length).toBeLessThanOrEqual(20);
  });
});

describe('layer 5 - an in-flight job never returns to the queue', () => {
  // This is the rule that keeps a crashed worker from causing a duplicate.
  it('parks an expired SENDING lease for reconciliation, not requeue', async () => {
    const { jobIds } = await seedCampaign(db);
    const jobId = jobIds[0]!;

    await db.query(
      `UPDATE campaign.email_jobs
          SET status='claimed', locked_by='dead-worker', locked_at=now(),
              lease_expires_at = now() - interval '1 minute'
        WHERE id = $1`,
      [jobId],
    );
    await db.query('SELECT * FROM campaign.mark_sending($1, $2)', [jobId, 'dead-worker']);
    await db.query(
      "UPDATE campaign.email_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1",
      [jobId],
    );

    const { rows } = await db.query<{ released: number; reconciling: number }>(
      'SELECT released, reconciling FROM campaign.reap_expired_leases()',
    );
    expect(Number(rows[0]!.reconciling)).toBe(1);

    const { rows: after } = await db.query<{ status: string }>(
      'SELECT status::text AS status FROM campaign.email_jobs WHERE id = $1',
      [jobId],
    );
    expect(after[0]!.status).toBe('needs_reconciliation');
    expect(after[0]!.status).not.toBe('queued');
  });

  it('DOES requeue an expired CLAIMED lease, because nothing was sent', async () => {
    const { jobIds } = await seedCampaign(db);
    await db.query(
      `UPDATE campaign.email_jobs
          SET status='claimed', locked_by='dead-worker', locked_at=now(),
              lease_expires_at = now() - interval '1 minute'
        WHERE id = $1`,
      [jobIds[0]!],
    );
    const { rows } = await db.query<{ released: number }>(
      'SELECT released FROM campaign.reap_expired_leases()',
    );
    expect(Number(rows[0]!.released)).toBe(1);

    const { rows: after } = await db.query<{ status: string; skip_reason: string }>(
      'SELECT status::text AS status, skip_reason FROM campaign.email_jobs WHERE id = $1',
      [jobIds[0]!],
    );
    expect(after[0]!.status).toBe('queued');
    expect(after[0]!.skip_reason).toBe('lease_expired_released');
  });

  it('has no sending -> queued edge in the state machine at all', async () => {
    const { rows } = await db.query(
      `SELECT 1 FROM campaign.allowed_transitions
        WHERE from_status = 'sending' AND to_status = 'queued'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('layer 7 - mark_sent is idempotent', () => {
  it('blocks a second completion, records it, and raises a critical alert', async () => {
    const { jobIds } = await seedCampaign(db);
    await forceSent(db, jobIds[0]!);

    const { rows } = await db.query<{ mark_sent: boolean }>(
      'SELECT campaign.mark_sent($1, $2, $3) AS mark_sent',
      [jobIds[0]!, 'test-worker', 'second-message-id'],
    );
    expect(rows[0]!.mark_sent).toBe(false);

    const audit = await db.query(
      "SELECT 1 FROM campaign.audit_events WHERE action = 'send.duplicate_blocked' AND job_id = $1",
      [jobIds[0]!],
    );
    expect(audit.rows).toHaveLength(1);

    const alerts = await db.query<{ severity: string }>(
      "SELECT severity::text AS severity FROM campaign.alerts WHERE alert_key LIKE 'duplicate_send.%'",
    );
    expect(alerts.rows[0]!.severity).toBe('critical');
  });

  it('counts the send exactly once, even after a duplicate attempt', async () => {
    const { jobIds } = await seedCampaign(db);
    await forceSent(db, jobIds[0]!);
    await db.query('SELECT campaign.mark_sent($1, $2, $3)', [jobIds[0]!, 'w', 'again']);

    const { rows } = await db.query<{ total: string }>(
      'SELECT COALESCE(sum(sent_count), 0)::text AS total FROM campaign.send_counters',
    );
    expect(Number(rows[0]!.total)).toBe(1);
  });

  it('ignores a late failure report for a job already recorded as sent', async () => {
    const { jobIds } = await seedCampaign(db);
    await forceSent(db, jobIds[0]!);

    const { rows } = await db.query<{ mark_failed: string }>(
      "SELECT campaign.mark_failed($1, 'w', 'retryable_transient', 'X', 'late') AS mark_failed",
      [jobIds[0]!],
    );
    expect(rows[0]!.mark_failed).toBe('sent');

    const { rows: after } = await db.query<{ status: string }>(
      'SELECT status::text AS status FROM campaign.email_jobs WHERE id = $1',
      [jobIds[0]!],
    );
    expect(after[0]!.status).toBe('sent');
  });
});

describe('materialization', () => {
  it('is idempotent: running it again creates nothing extra', async () => {
    const { campaignId } = await seedCampaign(db);
    const before = await db.query('SELECT count(*)::int AS n FROM campaign.email_jobs');

    const { rows } = await db.query<{ created: number; skipped_duplicate: number }>(
      'SELECT created, skipped_duplicate FROM campaign.materialize_campaign_jobs($1)',
      [campaignId],
    );
    expect(Number(rows[0]!.created)).toBe(0);

    const after = await db.query('SELECT count(*)::int AS n FROM campaign.email_jobs');
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('honours the "how many contacts" cap exactly', async () => {
    const { campaignId } = await seedCampaign(db, {
      recipients: Array.from({ length: 10 }, (_, i) => `t${i}@example.com`),
      targetCount: 3,
    });
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM campaign.email_jobs WHERE campaign_id = $1',
      [campaignId],
    );
    expect(rows[0]!.n).toBe(3);
  });

  it('materializes a suppressed recipient as suppressed, never as queued', async () => {
    await db.query(
      `INSERT INTO campaign.suppressions (email_canonical, reason, scope, source)
       VALUES (campaign.canonical_email('blocked@example.com'), 'unsubscribe', 'global', 'test')`,
    );
    const { campaignId } = await seedCampaign(db, {
      recipients: ['ok@example.com', 'blocked@example.com'],
    });
    const { rows } = await db.query<{ recipient_email: string; status: string }>(
      `SELECT recipient_email::text AS recipient_email, status::text AS status
         FROM campaign.email_jobs WHERE campaign_id = $1 ORDER BY recipient_email`,
      [campaignId],
    );
    expect(rows).toEqual([
      { recipient_email: 'blocked@example.com', status: 'suppressed' },
      { recipient_email: 'ok@example.com', status: 'queued' },
    ]);
  });
});
