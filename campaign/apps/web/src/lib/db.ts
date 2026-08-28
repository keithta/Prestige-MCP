/**
 * Database access for the control plane.
 *
 * Every query runs with `request.jwt.claims` set to the acting user, so the
 * SAME row level security policies apply here as would apply to a direct
 * PostgREST call. There is no "trust me, I checked in the app layer" path: if a
 * viewer tries to update a campaign, Postgres refuses, not this code.
 */
import 'server-only';
import { createPool, type Pool, type PoolClient } from '@campaign/core';

let pool: Pool | null = null;

export function db(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    pool = createPool(url, Number(process.env.DATABASE_POOL_MAX ?? 10));
  }
  return pool;
}

/**
 * Run queries as a specific user. The claim is set with SET LOCAL inside a
 * transaction, so it cannot leak to the next borrower of the pooled connection.
 */
export async function asUser<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await client.query("SET LOCAL ROLE authenticated");
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

/**
 * Elevated access, used only where the schema deliberately requires it: reading
 * the audit trail for display, and the unauthenticated unsubscribe endpoint.
 * Never used to bypass an authorization decision.
 */
export async function asService<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
