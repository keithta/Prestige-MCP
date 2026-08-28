/**
 * The sending worker: claim, send, report, repeat.
 *
 * Everything safety-critical lives in the database. This loop is deliberately
 * dumb: if claim_email_jobs() returns nothing, nothing sends -- whether the
 * cause is an emergency stop, a closed window, a rate limit, or a paused
 * campaign. The worker never asks why and never works around it.
 */
import {
  acquireWorkerLock,
  claimEmailJobs,
  getQueueHealth,
  getSenderForJob,
  reapExpiredLeases,
  recordGraphDraftId,
  releaseWorkerLeases,
  releaseWorkerLock,
  type EmailJob,
  type GraphConfig,
  type Logger,
  type Pool,
  type PoolClient,
  type WorkerConfig,
} from '@campaign/core';
import { GraphClient, createTokenProvider } from '@campaign/graph';
import { Metrics } from './metrics.js';
import { sendOneJob } from './sender.js';
import { reconcilePendingJobs } from './reconciler.js';

export interface WorkerDeps {
  db: Pool;
  config: WorkerConfig;
  graphConfig: GraphConfig;
  logger: Logger;
  metrics?: Metrics;
  /** Skip the single-instance advisory lock (tests run several workers). */
  skipSingleInstanceLock?: boolean;
}

interface SenderInfo {
  mailbox: string;
  replyTo: string | null;
  minIntervalSeconds: number;
  tenantId: string | null;
}

export class Worker {
  readonly metrics: Metrics;
  private running = false;
  private stopping = false;
  private lockClient: PoolClient | null = null;
  private loopPromise: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  private readonly graph: GraphClient;
  private readonly senderCache = new Map<string, SenderInfo>();
  private appBaseUrl: string | null = null;

  constructor(private readonly deps: WorkerDeps) {
    this.metrics = deps.metrics ?? new Metrics();

    const tokens = createTokenProvider(deps.graphConfig);
    this.graph = new GraphClient(deps.graphConfig, tokens, async (jobId, draftId) => {
      // Persist the draft id BEFORE the send is attempted. Without this, an
      // ambiguous send has no handle to reconcile against.
      //
      // Through a function, not an UPDATE: the worker's role holds no write
      // privilege on email_jobs, which is what makes claim_email_jobs() its
      // only route to a sendable email.
      await recordGraphDraftId(deps.db, jobId, draftId);
    });
  }

  private async senderFor(job: EmailJob): Promise<SenderInfo> {
    const cached = this.senderCache.get(job.sender_account_id);
    if (cached) return cached;

    const row = await getSenderForJob(this.deps.db, job.id);
    if (!row) throw new Error(`sender account ${job.sender_account_id} not found`);

    // A worker configured for one tenant must never send from a mailbox
    // belonging to another. This catches a mis-set GRAPH_TENANT_ID before a
    // single message leaves.
    if (row.tenant_id && row.tenant_id !== this.deps.graphConfig.GRAPH_TENANT_ID) {
      throw new Error(
        `sender ${row.mailbox_address} belongs to tenant ${row.tenant_id}, ` +
          `but this worker is configured for ${this.deps.graphConfig.GRAPH_TENANT_ID}`,
      );
    }

    this.setAppBaseUrl(row.app_base_url);

    const info: SenderInfo = {
      mailbox: row.mailbox_address,
      replyTo: row.reply_to,
      minIntervalSeconds: row.min_interval_seconds,
      tenantId: row.tenant_id,
    };
    this.senderCache.set(job.sender_account_id, info);
    return info;
  }

  /** Cached from the first job of the cycle; it changes only in Settings. */
  private setAppBaseUrl(value: string | null): string {
    this.appBaseUrl = (value ?? '').replace(/\/+$/, '');
    return this.appBaseUrl;
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!this.deps.skipSingleInstanceLock) {
      this.lockClient = await acquireWorkerLock(this.deps.db);
      if (!this.lockClient) {
        throw new Error(
          'Another sending worker already holds the single-instance lock. ' +
            'Refusing to start a second one. Stop the other instance first.',
        );
      }
    }

    this.running = true;
    this.stopping = false;
    this.deps.logger.info(
      {
        worker_id: this.deps.config.WORKER_ID,
        poll_interval_ms: this.deps.config.WORKER_POLL_INTERVAL_MS,
        batch_size: this.deps.config.WORKER_BATCH_SIZE,
        send_strategy: this.deps.graphConfig.GRAPH_SEND_STRATEGY,
      },
      'sending worker started',
    );

    this.loopPromise = this.loop();
  }

  /** Wakes the poll loop early. It cannot bypass any authorization check. */
  tick(): void {
    this.wakeUp?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = null;
        resolve();
      }, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runCycle();
        this.metrics.increment('poll_cycles_total');
      } catch (err) {
        this.metrics.increment('poll_errors_total');
        this.deps.logger.error({ err: (err as Error).message }, 'poll cycle failed');
      }
      if (this.stopping) break;
      await this.sleep(this.deps.config.WORKER_POLL_INTERVAL_MS);
    }
  }

  async runCycle(): Promise<{ claimed: number; sent: number; failed: number }> {
    const { db, config, logger } = this.deps;

    // Cleared each cycle so a change made in Settings -- a paused mailbox, a new
    // application URL -- lands on the next poll rather than needing a restart.
    this.senderCache.clear();

    // Recover anything abandoned by a dead worker before claiming more.
    const reaped = await reapExpiredLeases(db);
    if (reaped.released) this.metrics.increment('leases_reaped_total', reaped.released);
    if (reaped.reconciling) this.metrics.increment('leases_reconciling_total', reaped.reconciling);

    const health = await getQueueHealth(db);
    this.metrics.setGauge('queue_depth', health.queued);
    this.metrics.setGauge('queue_ready_now', health.ready_now);
    this.metrics.setGauge('queue_in_flight', health.in_flight);
    this.metrics.setGauge('queue_needs_reconciliation', health.needs_reconciliation);
    this.metrics.setGauge('queue_expired_leases', health.expired_leases);
    this.metrics.setGauge('emergency_stop', health.emergency_stop ? 1 : 0);
    this.metrics.setGauge('global_send_enabled', health.global_send_enabled ? 1 : 0);
    this.metrics.setGauge('production_mode', health.production_mode ? 1 : 0);
    this.metrics.setGauge('open_critical_alerts', health.open_critical_alerts);

    if (health.needs_reconciliation > 0) {
      const summary = await reconcilePendingJobs({
        db, graph: this.graph, workerId: config.WORKER_ID, logger,
        mailboxFor: async (job) => {
          const s = await this.senderFor(job);
          return { mailbox: s.mailbox, replyTo: s.replyTo };
        },
      });
      this.metrics.increment('reconciled_sent_total', summary.confirmedSent);
      this.metrics.increment('reconciled_not_sent_total', summary.confirmedNotSent);
      this.metrics.increment('reconciled_undetermined_total', summary.undetermined);
    }

    const jobs = await claimEmailJobs(db, {
      workerId: config.WORKER_ID,
      limit: config.WORKER_BATCH_SIZE,
      leaseSeconds: config.WORKER_LEASE_SECONDS,
    });
    this.metrics.increment('jobs_claimed_total', jobs.length);
    if (jobs.length === 0) return { claimed: 0, sent: 0, failed: 0 };

    let sent = 0;
    let failed = 0;

    for (const job of jobs) {
      if (this.stopping) {
        // Hand back what we have not started, so a redeploy does not strand work.
        await releaseWorkerLeases(db, config.WORKER_ID);
        break;
      }

      const sender = await this.senderFor(job);
      const appBaseUrl = this.appBaseUrl ?? '';

      const outcome = await sendOneJob(
        {
          db, graph: this.graph, workerId: config.WORKER_ID, logger,
          mailboxFor: async () => ({ mailbox: sender.mailbox, replyTo: sender.replyTo }),
          unsubscribeUrlFor: (j) =>
            appBaseUrl ? `${appBaseUrl}/u/${j.unsubscribe_token}` : null,
        },
        job,
      );

      switch (outcome.kind) {
        case 'sent':
          sent += 1;
          this.metrics.increment('jobs_sent_total');
          break;
        case 'failed':
          failed += 1;
          this.metrics.increment('jobs_failed_total');
          if (outcome.failureClass === 'ambiguous') this.metrics.increment('jobs_ambiguous_total');
          break;
        case 'refused':
          this.metrics.increment('jobs_refused_total');
          break;
        case 'skipped':
          this.metrics.increment('duplicates_blocked_total');
          break;
      }

      // Client-side pacing, on top of the database's min-gap check. Keeps us
      // comfortably under Exchange Online's per-minute throttling.
      if (sender.minIntervalSeconds > 0 && !this.stopping) {
        await this.sleep(sender.minIntervalSeconds * 1000);
      }
    }

    return { claimed: jobs.length, sent, failed };
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.deps.logger.info('sending worker stopping; releasing leases');
    this.stopping = true;
    this.wakeUp?.();

    if (this.loopPromise) await this.loopPromise.catch(() => undefined);

    try {
      const released = await releaseWorkerLeases(this.deps.db, this.deps.config.WORKER_ID);
      if (released > 0) {
        this.deps.logger.info({ released }, 'released un-started leases');
      }
    } catch (err) {
      this.deps.logger.error({ err: (err as Error).message }, 'failed to release leases on shutdown');
    }

    if (this.lockClient) {
      await releaseWorkerLock(this.lockClient);
      this.lockClient = null;
    }
    this.running = false;
    this.deps.logger.info('sending worker stopped');
  }

  isRunning(): boolean {
    return this.running;
  }
}
