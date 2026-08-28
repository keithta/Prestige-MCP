/**
 * n8n has no send authority.
 *
 * The architecture claims that an email can never be sent because a workflow
 * fired. That claim is only worth anything if it is enforced, so this asserts
 * the boundary directly against the role n8n actually uses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, seedCampaign } from '@campaign/testing';
import { createPool, type Pool } from '@campaign/core';
import { closeTestDb, getTestDb, testDbUrl } from '../helpers.js';

let db: Pool;
let asN8n: Pool;

beforeAll(async () => {
  db = await getTestDb();
  // campaign_readonly is NOLOGIN, so connect normally and drop into the role,
  // which is exactly the privilege set n8n's credential would have.
  asN8n = createPool(testDbUrl(), 3);
});

afterAll(async () => {
  await asN8n.end();
  await closeTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
});

/** Run a statement with the privileges of the n8n role. */
async function n8nQuery(sql: string, params: unknown[] = []): Promise<unknown> {
  const client = await asN8n.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE campaign_readonly');
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

describe('the n8n role', () => {
  it('can read the alerts it exists to deliver', async () => {
    await db.query(
      "SELECT campaign.raise_alert('test.alert', 'warning', 'Test alert', 'detail')",
    );
    const result = (await n8nQuery('SELECT id, title FROM campaign.alerts')) as { rows: unknown[] };
    expect(result.rows).toHaveLength(1);
  });

  it('can mark an alert as notified, which is its only write anywhere', async () => {
    await db.query("SELECT campaign.raise_alert('test.alert', 'warning', 'Test alert')");
    // Assert the row COUNT, not merely that no error was raised: under RLS a
    // missing policy makes an update a silent no-op rather than a failure.
    const result = (await n8nQuery(
      'UPDATE campaign.alerts SET notified_at = now() WHERE resolved_at IS NULL',
    )) as { rowCount: number };
    expect(result.rowCount).toBe(1);
  });

  it('can read queue health for the digest', async () => {
    await expect(n8nQuery('SELECT * FROM campaign.queue_health')).resolves.toBeDefined();
  });

  // The properties that matter.
  it('CANNOT read contact data', async () => {
    await seedCampaign(db);
    await expect(n8nQuery('SELECT * FROM campaign.contacts')).rejects.toThrow(/permission denied/);
  });

  it('CANNOT read or write email jobs', async () => {
    await seedCampaign(db);
    await expect(n8nQuery('SELECT * FROM campaign.email_jobs')).rejects.toThrow(/permission denied/);
    await expect(
      n8nQuery("UPDATE campaign.email_jobs SET status = 'queued'"),
    ).rejects.toThrow(/permission denied/);
  });

  it('CANNOT claim a job for sending', async () => {
    await seedCampaign(db);
    await expect(
      n8nQuery("SELECT * FROM campaign.claim_email_jobs('n8n-pretending-to-be-a-worker', 10, 60)"),
    ).rejects.toThrow(/permission denied/);
  });

  it('CANNOT mark a job as sent', async () => {
    const { jobIds } = await seedCampaign(db);
    await expect(
      n8nQuery("SELECT campaign.mark_sent($1, 'n8n')", [jobIds[0]!]),
    ).rejects.toThrow(/permission denied/);
  });

  it('CANNOT change the global controls', async () => {
    await expect(
      n8nQuery('UPDATE campaign.system_controls SET emergency_stop = false'),
    ).rejects.toThrow(/permission denied/);
    await expect(
      n8nQuery("SELECT campaign.set_production_mode(true, 'n8n')"),
    ).rejects.toThrow(/permission denied/);
  });

  it('CANNOT approve or start a campaign', async () => {
    const { campaignId } = await seedCampaign(db, { approve: false, start: false });
    await expect(
      n8nQuery("SELECT campaign.approve_campaign($1, 'n8n')", [campaignId]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      n8nQuery('SELECT campaign.start_campaign($1)', [campaignId]),
    ).rejects.toThrow(/permission denied/);
  });

  it('CANNOT remove a suppression', async () => {
    const { rows } = await db.query<{ id: string }>(
      "SELECT campaign.add_suppression('x@example.com', 'manual') AS id",
    );
    await expect(
      n8nQuery("SELECT campaign.revoke_suppression($1, 'n8n')", [rows[0]!.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      n8nQuery('DELETE FROM campaign.suppressions'),
    ).rejects.toThrow(/permission denied/);
  });
});
