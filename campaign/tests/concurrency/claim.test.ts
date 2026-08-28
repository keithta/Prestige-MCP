/**
 * The headline safety test.
 *
 * Eight independent database connections claim from the same queue as fast as
 * they can. If FOR UPDATE ... SKIP LOCKED is wrong -- or if anyone later
 * "optimises" the claim query -- the same job gets leased twice and somebody
 * receives the same email twice.
 *
 * A single-connection Postgres emulator cannot prove this; it needs a real
 * server with real concurrent transactions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, seedCampaign } from '@campaign/testing';
import { createPool, type Pool } from '@campaign/core';
import { closeTestDb, getTestDb, testDbUrl } from '../helpers.js';

const WORKERS = 8;
const JOBS = 1000;

let db: Pool;

beforeAll(async () => {
  db = await getTestDb();
}, 120_000);

afterAll(async () => {
  await closeTestDb();
});

describe('concurrent claiming', () => {
  it(
    `hands ${JOBS} jobs to ${WORKERS} workers with zero duplicates and zero losses`,
    async () => {
      await resetDatabase(db);
      const recipients = Array.from({ length: JOBS }, (_, i) => `load${i}@example.com`);
      const { campaignId } = await seedCampaign(db, { recipients });

      const queued = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM campaign.email_jobs WHERE campaign_id = $1 AND status = 'queued'",
        [campaignId],
      );
      expect(queued.rows[0]!.n).toBe(JOBS);

      // Each "worker" gets its own pool, so these are genuinely separate
      // connections competing for the same rows.
      const pools = Array.from({ length: WORKERS }, () => createPool(testDbUrl(), 2));
      const claimedBy = new Map<string, string>();
      const duplicates: Array<{ jobId: string; first: string; second: string }> = [];

      try {
        await Promise.all(
          pools.map(async (pool, index) => {
            const workerId = `race-worker-${index}`;
            for (;;) {
              const { rows } = await pool.query<{ id: string }>(
                'SELECT id FROM campaign.claim_email_jobs($1, 25, 600)',
                [workerId],
              );
              if (rows.length === 0) break;

              for (const row of rows) {
                const existing = claimedBy.get(row.id);
                if (existing) {
                  duplicates.push({ jobId: row.id, first: existing, second: workerId });
                } else {
                  claimedBy.set(row.id, workerId);
                }
              }
            }
          }),
        );
      } finally {
        await Promise.all(pools.map((p) => p.end()));
      }

      // The property that matters.
      expect(duplicates).toEqual([]);

      // And nothing was lost: every job ended up leased exactly once.
      expect(claimedBy.size).toBe(JOBS);

      const { rows } = await db.query<{ status: string; count: string }>(
        `SELECT status::text AS status, count(*)::text AS count
           FROM campaign.email_jobs WHERE campaign_id = $1 GROUP BY 1`,
        [campaignId],
      );
      expect(rows).toEqual([{ status: 'claimed', count: String(JOBS) }]);

      // Every job carries exactly one lease holder.
      const distinct = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM campaign.email_jobs
          WHERE campaign_id = $1 AND locked_by IS NULL`,
        [campaignId],
      );
      expect(distinct.rows[0]!.n).toBe(0);
    },
    180_000,
  );

  it('respects a rate limit even under concurrent pressure', async () => {
    await resetDatabase(db);
    const recipients = Array.from({ length: 50 }, (_, i) => `cap${i}@example.com`);
    // Only 5 sends are permitted this hour, across every worker.
    const { campaignId, senderId } = await seedCampaign(db, { hourlyLimit: 5, dailyLimit: 100 });
    await db.query('DELETE FROM campaign.email_jobs WHERE campaign_id = $1', [campaignId]);
    for (const [i, email] of recipients.entries()) {
      await db.query(
        `INSERT INTO campaign.contacts (email) VALUES ($1)
         ON CONFLICT (email_canonical) DO NOTHING`,
        [email],
      );
      await db.query(
        `INSERT INTO campaign.test_recipients (email_canonical) VALUES (campaign.canonical_email($1))
         ON CONFLICT DO NOTHING`,
        [email],
      );
      await db.query(
        `INSERT INTO campaign.campaign_recipients (campaign_id, contact_id, position)
         SELECT $1, id, $2 FROM campaign.contacts WHERE email = $3
         ON CONFLICT DO NOTHING`,
        [campaignId, i + 1, email],
      );
    }
    await db.query('SELECT * FROM campaign.materialize_campaign_jobs($1)', [campaignId]);
    await db.query(
      "UPDATE campaign.email_jobs SET status='queued' WHERE campaign_id=$1 AND status='pending'",
      [campaignId],
    );

    // Simulate 5 already sent this hour: the limit is now exhausted.
    await db.query(
      `INSERT INTO campaign.send_counters (sender_account_id, campaign_id, bucket_hour, sent_count)
       VALUES ($1, $2, date_trunc('hour', now()), 5)
       ON CONFLICT (sender_account_id, campaign_id, bucket_hour)
       DO UPDATE SET sent_count = 5`,
      [senderId, campaignId],
    );

    const pools = Array.from({ length: 4 }, () => createPool(testDbUrl(), 2));
    try {
      const results = await Promise.all(
        pools.map((pool, i) =>
          pool.query<{ id: string }>('SELECT id FROM campaign.claim_email_jobs($1, 50, 120)', [
            `cap-worker-${i}`,
          ]),
        ),
      );
      const totalClaimed = results.reduce((sum, r) => sum + r.rows.length, 0);
      expect(totalClaimed).toBe(0);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  }, 120_000);
});
