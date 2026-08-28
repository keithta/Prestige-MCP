/**
 * The worker cannot hand itself work.
 *
 * The architecture's central claim is that claim_email_jobs() is the only route
 * to a sendable email. That is only true if the worker's database role has no
 * way around it, so this asserts the privilege boundary directly rather than
 * trusting the worker's own code to behave.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, seedCampaign } from '@campaign/testing';
import { createPool, type Pool } from '@campaign/core';
import { closeTestDb, getTestDb, testDbUrl } from '../helpers.js';

let db: Pool;
let workerPool: Pool;

beforeAll(async () => {
  db = await getTestDb();
  workerPool = createPool(testDbUrl(), 3);
});

afterAll(async () => {
  await workerPool.end();
  await closeTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
});

/** Run a statement with exactly the privileges the worker role holds. */
async function asWorker(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
  const client = await workerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE campaign_worker');
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result as { rows: unknown[] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

describe('the worker role can do its job', () => {
  it('claims authorized work', async () => {
    await seedCampaign(db, { recipients: ['a@example.com', 'b@example.com'] });
    const result = await asWorker("SELECT id FROM campaign.claim_email_jobs('w', 10, 120)");
    expect(result.rows).toHaveLength(2);
  });

  it('records an outcome through the lifecycle functions', async () => {
    const { jobIds } = await seedCampaign(db, { recipients: ['a@example.com'] });
    await asWorker("SELECT id FROM campaign.claim_email_jobs('w', 10, 120)");
    await asWorker("SELECT ok FROM campaign.mark_sending($1, 'w')", [jobIds[0]!]);
    await asWorker("SELECT campaign.mark_sent($1, 'w', 'msg-1')", [jobIds[0]!]);

    const { rows } = await db.query<{ status: string }>(
      'SELECT status::text AS status FROM campaign.email_jobs WHERE id = $1',
      [jobIds[0]!],
    );
    expect(rows[0]!.status).toBe('sent');
  });

  it('records a draft id without holding an UPDATE privilege', async () => {
    const { jobIds } = await seedCampaign(db, { recipients: ['a@example.com'] });
    await asWorker("SELECT id FROM campaign.claim_email_jobs('w', 10, 120)");
    await asWorker('SELECT campaign.record_graph_draft_id($1, $2)', [jobIds[0]!, 'draft-abc']);

    const { rows } = await db.query<{ graph_draft_id: string }>(
      'SELECT graph_draft_id FROM campaign.email_jobs WHERE id = $1',
      [jobIds[0]!],
    );
    expect(rows[0]!.graph_draft_id).toBe('draft-abc');
  });

  it('reads queue health for /health and /metrics', async () => {
    await expect(asWorker('SELECT * FROM campaign.queue_health')).resolves.toBeDefined();
  });
});

describe('the worker role cannot go around the authorization function', () => {
  it('CANNOT insert a job', async () => {
    const { campaignId, contactIds, senderId } = await seedCampaign(db);
    await expect(
      asWorker(
        `INSERT INTO campaign.email_jobs
           (campaign_id, contact_id, sender_account_id, content_version_hash,
            recipient_email, subject, body_text, status)
         VALUES ($1, $2, $3, 'x', 'sneaky@example.com', 's', 'b', 'queued')`,
        [campaignId, contactIds[0]!, senderId],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  // The one that matters: hand-marking a job sendable would bypass every check.
  it('CANNOT change a job to queued directly', async () => {
    const { jobIds } = await seedCampaign(db);
    await expect(
      asWorker("UPDATE campaign.email_jobs SET status = 'queued' WHERE id = $1", [jobIds[0]!]),
    ).rejects.toThrow(/permission denied/);
  });

  it('CANNOT clear its own backoff', async () => {
    const { jobIds } = await seedCampaign(db);
    await expect(
      asWorker('UPDATE campaign.email_jobs SET available_at = now() WHERE id = $1', [jobIds[0]!]),
    ).rejects.toThrow(/permission denied/);
  });

  it('CANNOT move a send counter', async () => {
    await expect(
      asWorker('UPDATE campaign.send_counters SET sent_count = 0'),
    ).rejects.toThrow(/permission denied/);
  });

  it('CANNOT release the emergency stop', async () => {
    await db.query("SELECT campaign.set_emergency_stop(true, 'test')");
    await expect(
      asWorker('UPDATE campaign.system_controls SET emergency_stop = false'),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asWorker('SELECT campaign.set_emergency_stop(false)'),
    ).rejects.toThrow(/permission denied/);
  });

  it('CANNOT approve a campaign or enable production mode', async () => {
    const { campaignId } = await seedCampaign(db, { approve: false, start: false });
    await expect(
      asWorker("SELECT campaign.approve_campaign($1, 'worker')", [campaignId]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asWorker("SELECT campaign.set_production_mode(true, 'worker')", []),
    ).rejects.toThrow(/permission denied/);
  });

  it('CANNOT remove a suppression', async () => {
    const { rows } = await db.query<{ id: string }>(
      "SELECT campaign.add_suppression('x@example.com', 'manual') AS id",
    );
    await expect(
      asWorker("SELECT campaign.revoke_suppression($1, 'worker')", [rows[0]!.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(asWorker('DELETE FROM campaign.suppressions')).rejects.toThrow(/permission denied/);
  });

  it('CANNOT read contact records directly', async () => {
    await seedCampaign(db);
    await expect(asWorker('SELECT * FROM campaign.contacts')).rejects.toThrow(/permission denied/);
  });

  it('CANNOT rewrite the audit trail', async () => {
    await seedCampaign(db);
    await expect(
      asWorker("UPDATE campaign.audit_events SET action = 'tampered'"),
    ).rejects.toThrow(/permission denied|append-only/);
    await expect(asWorker('DELETE FROM campaign.audit_events')).rejects.toThrow(
      /permission denied|append-only/,
    );
  });
});
