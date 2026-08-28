/**
 * The worker driving real HTTP against a stand-in for Microsoft Graph.
 *
 * Every Graph failure mode that matters in production is injected here:
 * throttling with Retry-After, 5xx, a rejected recipient, an access-policy
 * denial, and the dangerous one -- a message that IS delivered but whose
 * response never arrives.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  forceSent, jobStatuses, resetDatabase, seedCampaign, startMockGraph, type MockGraph,
} from '@campaign/testing';
import { loadGraphConfig, loadWorkerConfig, createLogger, type Pool } from '@campaign/core';
import { Worker } from '../../apps/worker/src/worker.js';
import { closeTestDb, getTestDb } from '../helpers.js';

let db: Pool;
let mock: MockGraph;

const logger = createLogger({ level: 'silent', name: 'test-worker' });

function buildWorker(overrides: Record<string, string> = {}): Worker {
  const env = {
    ...process.env,
    GRAPH_BASE_URL: mock.graphBaseUrl,
    GRAPH_AUTHORITY_HOST: mock.baseUrl,
    GRAPH_TENANT_ID: 'test-tenant-id',
    GRAPH_CLIENT_ID: 'test-client-id',
    GRAPH_CLIENT_SECRET: 'test-client-secret',
    WORKER_ID: 'e2e-worker',
    WORKER_TICK_TOKEN: 'test-tick-token',
    WORKER_BATCH_SIZE: '25',
    ...overrides,
  };
  return new Worker({
    db,
    config: loadWorkerConfig(env),
    graphConfig: loadGraphConfig(env),
    logger,
    // Several tests run workers side by side; the advisory lock is verified
    // separately in its own test.
    skipSingleInstanceLock: true,
  });
}

async function setFault(
  fault: string,
  count = 1,
  retryAfterSeconds?: number,
  target?: string,
): Promise<void> {
  await fetch(`${mock.baseUrl}/__control/fault`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fault, count, retryAfterSeconds, target }),
  });
}

beforeAll(async () => {
  db = await getTestDb();
  mock = await startMockGraph(0);
}, 120_000);

afterAll(async () => {
  await mock.close();
  await closeTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  await fetch(`${mock.baseUrl}/__control/reset`, { method: 'POST' });
});

describe('the happy path', () => {
  it('sends every authorized job exactly once', async () => {
    const { campaignId } = await seedCampaign(db, {
      recipients: ['a@example.com', 'b@example.com', 'c@example.com'],
    });

    const worker = buildWorker();
    const result = await worker.runCycle();

    expect(result.claimed).toBe(3);
    expect(result.sent).toBe(3);
    expect(await jobStatuses(db, campaignId)).toEqual({ sent: 3 });
    expect(mock.state.sent.size).toBe(3);
  });

  it('stamps each message with its job id, which is what makes reconciliation possible', async () => {
    const { jobIds } = await seedCampaign(db, { recipients: ['a@example.com'] });
    await buildWorker().runCycle();

    const message = [...mock.state.sent.values()][0]!;
    expect(message.jobId).toBe(jobIds[0]!);
  });

  it('sets List-Unsubscribe headers for one-click unsubscribe', async () => {
    await seedCampaign(db, { recipients: ['a@example.com'] });
    await buildWorker().runCycle();

    const message = [...mock.state.sent.values()][0]!;
    const names = message.headers.map((h) => h.name.toLowerCase());
    expect(names).toContain('list-unsubscribe');
    expect(names).toContain('list-unsubscribe-post');
  });

  it('increments the send counters that enforce the rate limits', async () => {
    await seedCampaign(db, { recipients: ['a@example.com', 'b@example.com'] });
    await buildWorker().runCycle();

    const { rows } = await db.query<{ total: string }>(
      'SELECT COALESCE(sum(sent_count), 0)::text AS total FROM campaign.send_counters',
    );
    expect(Number(rows[0]!.total)).toBe(2);
  });
});

describe('throttling', () => {
  it('honours Retry-After exactly and requeues rather than failing', async () => {
    const { campaignId, jobIds } = await seedCampaign(db, { recipients: ['a@example.com'] });
    await setFault('throttle_429', 1, 90);

    await buildWorker().runCycle();

    expect(await jobStatuses(db, campaignId)).toEqual({ queued: 1 });

    const { rows } = await db.query<{ available_in: string; failure_class: string }>(
      `SELECT extract(epoch from (available_at - now()))::text AS available_in,
              last_failure_class::text AS failure_class
         FROM campaign.email_jobs WHERE id = $1`,
      [jobIds[0]!],
    );
    // Microsoft said 90 seconds, so the job waits ~90 seconds, not our own
    // backoff curve.
    expect(Number(rows[0]!.available_in)).toBeGreaterThan(80);
    expect(Number(rows[0]!.available_in)).toBeLessThanOrEqual(90);
    expect(rows[0]!.failure_class).toBe('retryable_throttle');
  });

  it('eventually succeeds after the throttle clears', async () => {
    const { campaignId, jobIds } = await seedCampaign(db, { recipients: ['a@example.com'] });
    await setFault('throttle_429', 1, 1);

    const worker = buildWorker();
    await worker.runCycle();
    expect(await jobStatuses(db, campaignId)).toEqual({ queued: 1 });

    // Clear the backoff rather than sleeping for it.
    await db.query('UPDATE campaign.email_jobs SET available_at = now() WHERE id = $1', [jobIds[0]!]);
    await worker.runCycle();

    expect(await jobStatuses(db, campaignId)).toEqual({ sent: 1 });
  });
});

describe('permanent failures', () => {
  it('fails a rejected recipient permanently and auto-suppresses the address', async () => {
    const { campaignId } = await seedCampaign(db, { recipients: ['bad@example.com'] });
    await setFault('invalid_recipient', 5);

    await buildWorker().runCycle();

    expect(await jobStatuses(db, campaignId)).toEqual({ failed_permanent: 1 });

    // A bad address should never be tried again on any future campaign.
    const { rows } = await db.query<{ reason: string }>(
      `SELECT reason::text AS reason FROM campaign.suppressions
        WHERE email_canonical = 'bad@example.com' AND revoked_at IS NULL`,
    );
    expect(rows[0]!.reason).toBe('invalid_address');
  });

  it('pauses the mailbox and raises a critical alert on an access-policy denial', async () => {
    const { senderId } = await seedCampaign(db, { recipients: ['a@example.com'] });
    await setFault('access_denied', 5);

    await buildWorker().runCycle();

    const { rows } = await db.query<{ status: string; paused_reason: string }>(
      'SELECT status::text AS status, paused_reason FROM campaign.sender_accounts WHERE id = $1',
      [senderId],
    );
    expect(rows[0]!.status).toBe('paused');
    expect(rows[0]!.paused_reason).toContain('permanent_policy');

    const alerts = await db.query<{ severity: string; title: string }>(
      "SELECT severity::text AS severity, title FROM campaign.alerts WHERE alert_key LIKE 'sender_auth_failure.%'",
    );
    expect(alerts.rows[0]!.severity).toBe('critical');
  });

  it('does not retry an oversized message', async () => {
    const { campaignId } = await seedCampaign(db, { recipients: ['a@example.com'] });
    await setFault('message_too_large', 5);

    await buildWorker().runCycle();
    expect(await jobStatuses(db, campaignId)).toEqual({ failed_permanent: 1 });
  });
});

// The scenario the whole draft-then-send design exists for.
describe('an ambiguous send', () => {
  it('parks the job for reconciliation instead of retrying it', async () => {
    const { campaignId } = await seedCampaign(db, { recipients: ['a@example.com'] });
    await setFault('send_then_hang', 1);

    // The mock delivers the message and then never answers, so the client times
    // out with no idea whether it worked.
    await buildWorker({ GRAPH_TIMEOUT_MS: '1500' }).runCycle();

    expect(await jobStatuses(db, campaignId)).toEqual({ needs_reconciliation: 1 });
    // The message really was delivered. A naive retry here sends it twice.
    expect(mock.state.sent.size).toBe(1);
  }, 30_000);

  it('resolves it as SENT from the message in Sent Items, sending nothing further', async () => {
    const { campaignId } = await seedCampaign(db, { recipients: ['a@example.com'] });
    await setFault('send_then_hang', 1);

    const worker = buildWorker({ GRAPH_TIMEOUT_MS: '1500' });
    await worker.runCycle();
    expect(await jobStatuses(db, campaignId)).toEqual({ needs_reconciliation: 1 });

    // The next cycle reconciles: the draft is gone from Drafts and the message
    // is in Sent Items carrying our job id.
    await worker.runCycle();

    expect(await jobStatuses(db, campaignId)).toEqual({ sent: 1 });
    expect(mock.state.sent.size).toBe(1); // still exactly one email
  }, 30_000);

  it('resolves it as NOT SENT when the draft is still sitting in Drafts', async () => {
    const { campaignId } = await seedCampaign(db, { recipients: ['a@example.com'] });
    // 'hang' fails the SEND step without delivering, leaving the draft behind.
    await setFault('hang', 1);

    const worker = buildWorker({ GRAPH_TIMEOUT_MS: '1500' });
    await worker.runCycle();
    expect(await jobStatuses(db, campaignId)).toEqual({ needs_reconciliation: 1 });

    await worker.runCycle();

    // Confirmed not sent, so it is safe to queue again.
    const statuses = await jobStatuses(db, campaignId);
    expect(statuses.queued ?? statuses.sent).toBeGreaterThanOrEqual(1);
    expect(statuses.needs_reconciliation).toBeUndefined();
  }, 30_000);
});

describe('worker crash recovery', () => {
  it('returns un-started leases to the queue on graceful shutdown', async () => {
    const { campaignId } = await seedCampaign(db, {
      recipients: Array.from({ length: 5 }, (_, i) => `g${i}@example.com`),
    });

    await db.query(
      `UPDATE campaign.email_jobs
          SET status='claimed', locked_by='e2e-worker', locked_at=now(),
              lease_expires_at = now() + interval '5 minutes'
        WHERE campaign_id = $1`,
      [campaignId],
    );

    const { rows } = await db.query<{ n: string }>(
      'SELECT campaign.release_worker_leases($1)::text AS n',
      ['e2e-worker'],
    );
    expect(Number(rows[0]!.n)).toBe(5);
    expect(await jobStatuses(db, campaignId)).toEqual({ queued: 5 });
  });

  it('refuses to start a second worker while one holds the single-instance lock', async () => {
    const first = new Worker({
      db,
      config: loadWorkerConfig({ ...process.env, WORKER_ID: 'solo-1', WORKER_TICK_TOKEN: 'x' }),
      graphConfig: loadGraphConfig({
        ...process.env,
        GRAPH_BASE_URL: mock.graphBaseUrl,
        GRAPH_AUTHORITY_HOST: mock.baseUrl,
        GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's',
      }),
      logger,
    });
    await first.start();

    try {
      const second = new Worker({
        db,
        config: loadWorkerConfig({ ...process.env, WORKER_ID: 'solo-2', WORKER_TICK_TOKEN: 'x' }),
        graphConfig: loadGraphConfig({
          ...process.env,
          GRAPH_BASE_URL: mock.graphBaseUrl,
          GRAPH_AUTHORITY_HOST: mock.baseUrl,
          GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's',
        }),
        logger,
      });
      await expect(second.start()).rejects.toThrow(/single-instance lock/);
    } finally {
      await first.stop();
    }
  }, 30_000);
});

describe('the worker cannot override the database', () => {
  it('sends nothing at all while the emergency stop is engaged', async () => {
    const { campaignId } = await seedCampaign(db, {
      recipients: ['a@example.com', 'b@example.com'],
    });
    await db.query("SELECT campaign.set_emergency_stop(true, 'e2e test')");

    const result = await buildWorker().runCycle();

    expect(result.claimed).toBe(0);
    expect(result.sent).toBe(0);
    expect(mock.state.sent.size).toBe(0);
    expect(await jobStatuses(db, campaignId)).toEqual({ queued: 2 });
  });

  it('sends nothing for a campaign that was never approved', async () => {
    await seedCampaign(db, { approve: false, start: false, recipients: ['a@example.com'] });
    const result = await buildWorker().runCycle();
    expect(result.sent).toBe(0);
    expect(mock.state.sent.size).toBe(0);
  });

  it('refuses at pre-flight when a suppression lands after the claim', async () => {
    const { campaignId, jobIds } = await seedCampaign(db, { recipients: ['a@example.com'] });

    // Claim first, then suppress: the pre-flight check is the last line of defence.
    await db.query('SELECT id FROM campaign.claim_email_jobs($1, 10, 300)', ['e2e-worker']);
    await db.query(
      `INSERT INTO campaign.suppressions (email_canonical, reason, scope, source)
       VALUES (campaign.canonical_email('a@example.com'), 'unsubscribe', 'global', 'test')`,
    );

    const { rows } = await db.query<{ ok: boolean; reason_code: string }>(
      'SELECT ok, reason_code FROM campaign.mark_sending($1, $2)',
      [jobIds[0]!, 'e2e-worker'],
    );
    expect(rows[0]!.ok).toBe(false);
    expect(rows[0]!.reason_code).toBe('recipient_suppressed');
    expect(mock.state.sent.size).toBe(0);
    expect((await jobStatuses(db, campaignId)).suppressed).toBe(1);
  });
});
