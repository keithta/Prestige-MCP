/** Shared database handle for integration tests. */
import { execSync } from 'node:child_process';
import { createPool, type Pool } from '@campaign/core';

let pool: Pool | null = null;
let migrated = false;

export function testDbUrl(): string {
  return process.env.DATABASE_URL ?? 'postgresql://campaign:campaign@127.0.0.1:55432/campaign_test';
}

export async function getTestDb(): Promise<Pool> {
  if (!pool) {
    // Bring the cluster up and migrate once per run, so a developer can just
    // type `npm test` without a separate setup step.
    if (!migrated) {
      execSync('bash scripts/pg-local.sh up', { stdio: 'pipe' });
      execSync('npx tsx scripts/migrate.ts', {
        stdio: 'pipe',
        env: { ...process.env, DATABASE_URL: testDbUrl() },
      });
      migrated = true;
    }
    pool = createPool(testDbUrl(), 20);
  }
  return pool;
}

export async function closeTestDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Move a campaign's clock so window-dependent behaviour is testable. */
export async function setSchedule(
  db: Pool,
  campaignId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await db.query(
    `UPDATE campaign.campaign_schedules SET ${sets} WHERE campaign_id = $1`,
    [campaignId, ...keys.map((k) => patch[k])],
  );
}
