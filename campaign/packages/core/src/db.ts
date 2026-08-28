/**
 * Database access.
 *
 * Every call the execution plane makes goes through the authorization functions
 * in the `campaign` schema. There is intentionally no helper here that updates
 * email_jobs directly -- the worker's database role is denied that privilege,
 * and this module reflects the same boundary in code.
 */
import pg from 'pg';
import type { EmailJob, FailureClass, QueueHealth } from './types.js';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

let pool: pg.Pool | null = null;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Supabase terminates non-TLS connections; the local test cluster has no TLS.
    ssl: /supabase\.(co|com)/.test(connectionString) ? { rejectUnauthorized: true } : undefined,
    application_name: 'campaign-app',
  });
}

export function getPool(connectionString?: string, max?: number): pg.Pool {
  if (!pool) {
    const cs = connectionString ?? process.env.DATABASE_URL;
    if (!cs) throw new Error('DATABASE_URL is not set');
    pool = createPool(cs, max);
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Run a function inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  db: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Execution plane. Thin wrappers over the database's authorization functions.
// ---------------------------------------------------------------------------

export async function claimEmailJobs(
  db: pg.Pool,
  opts: { workerId: string; limit: number; leaseSeconds: number; senderAccountId?: string | null },
): Promise<EmailJob[]> {
  const { rows } = await db.query<EmailJob>(
    'SELECT * FROM campaign.claim_email_jobs($1, $2, $3, $4)',
    [opts.workerId, opts.limit, opts.leaseSeconds, opts.senderAccountId ?? null],
  );
  return rows;
}

export interface MarkSendingResult {
  ok: boolean;
  attempt_no: number;
  reason_code: string | null;
}

export async function markSending(
  db: pg.Pool,
  jobId: string,
  workerId: string,
): Promise<MarkSendingResult> {
  const { rows } = await db.query<MarkSendingResult>(
    'SELECT ok, attempt_no, reason_code FROM campaign.mark_sending($1, $2)',
    [jobId, workerId],
  );
  const row = rows[0];
  if (!row) throw new Error(`mark_sending returned no row for job ${jobId}`);
  return row;
}

export async function markSent(
  db: pg.Pool,
  opts: {
    jobId: string;
    workerId: string;
    graphMessageId?: string | null;
    internetMessageId?: string | null;
    httpStatus?: number | null;
    graphRequestId?: string | null;
  },
): Promise<boolean> {
  const { rows } = await db.query<{ mark_sent: boolean }>(
    'SELECT campaign.mark_sent($1, $2, $3, $4, $5, $6) AS mark_sent',
    [
      opts.jobId, opts.workerId,
      opts.graphMessageId ?? null, opts.internetMessageId ?? null,
      opts.httpStatus ?? null, opts.graphRequestId ?? null,
    ],
  );
  return rows[0]?.mark_sent ?? false;
}

export async function markFailed(
  db: pg.Pool,
  opts: {
    jobId: string;
    workerId: string;
    failureClass: FailureClass;
    errorCode?: string | null;
    errorMessage?: string | null;
    httpStatus?: number | null;
    graphRequestId?: string | null;
    retryAfterSeconds?: number | null;
  },
): Promise<string> {
  const { rows } = await db.query<{ mark_failed: string }>(
    'SELECT campaign.mark_failed($1, $2, $3, $4, $5, $6, $7, $8) AS mark_failed',
    [
      opts.jobId, opts.workerId, opts.failureClass,
      opts.errorCode ?? null, opts.errorMessage ?? null,
      opts.httpStatus ?? null, opts.graphRequestId ?? null,
      opts.retryAfterSeconds ?? null,
    ],
  );
  return rows[0]?.mark_failed ?? 'failed_permanent';
}

export async function reapExpiredLeases(
  db: pg.Pool,
): Promise<{ released: number; reconciling: number; retried: number }> {
  const { rows } = await db.query<{ released: number; reconciling: number; retried: number }>(
    'SELECT released, reconciling, retried FROM campaign.reap_expired_leases()',
  );
  return rows[0] ?? { released: 0, reconciling: 0, retried: 0 };
}

export async function releaseWorkerLeases(db: pg.Pool, workerId: string): Promise<number> {
  const { rows } = await db.query<{ release_worker_leases: number }>(
    'SELECT campaign.release_worker_leases($1) AS release_worker_leases',
    [workerId],
  );
  return rows[0]?.release_worker_leases ?? 0;
}

export async function resolveReconciliation(
  db: pg.Pool,
  opts: {
    jobId: string;
    wasSent: boolean;
    workerId: string;
    evidence?: string | null;
    graphMessageId?: string | null;
    internetMessageId?: string | null;
  },
): Promise<string> {
  const { rows } = await db.query<{ resolve_reconciliation: string }>(
    'SELECT campaign.resolve_reconciliation($1, $2, $3, $4, $5, $6) AS resolve_reconciliation',
    [
      opts.jobId, opts.wasSent, opts.workerId,
      opts.evidence ?? null, opts.graphMessageId ?? null, opts.internetMessageId ?? null,
    ],
  );
  return rows[0]?.resolve_reconciliation ?? 'unknown';
}

export async function authorizeSend(
  db: pg.Pool,
  jobId: string,
): Promise<{ authorized: boolean; reasonCode: string | null }> {
  const { rows } = await db.query<{ authorized: boolean; reason_code: string | null }>(
    'SELECT authorized, reason_code FROM campaign.authorize_send($1)',
    [jobId],
  );
  const row = rows[0];
  return { authorized: row?.authorized ?? false, reasonCode: row?.reason_code ?? 'unknown' };
}

export async function getQueueHealth(db: pg.Pool): Promise<QueueHealth> {
  const { rows } = await db.query<QueueHealth>('SELECT * FROM campaign.queue_health');
  const row = rows[0];
  if (!row) throw new Error('queue_health returned no row');
  return row;
}

export async function getJobsNeedingReconciliation(
  db: pg.Pool,
  limit = 25,
): Promise<EmailJob[]> {
  const { rows } = await db.query<EmailJob>(
    `SELECT * FROM campaign.email_jobs
      WHERE status = 'needs_reconciliation'
      ORDER BY updated_at
      LIMIT $1`,
    [limit],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Single-instance guard.
//
// Two workers sending concurrently is safe (SKIP LOCKED guarantees disjoint
// work), but an accidentally double-installed Windows service is still a
// misconfiguration worth refusing. A session-level advisory lock makes the
// second instance fail loudly at boot instead of quietly doubling throughput.
// ---------------------------------------------------------------------------
const WORKER_LOCK_KEY = 8_242_617; // arbitrary, stable

export async function acquireWorkerLock(db: pg.Pool): Promise<pg.PoolClient | null> {
  const client = await db.connect();
  const { rows } = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [WORKER_LOCK_KEY],
  );
  if (rows[0]?.locked) return client;
  client.release();
  return null;
}

export async function releaseWorkerLock(client: pg.PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK_KEY]).catch(() => undefined);
  client.release();
}
