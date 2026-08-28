/**
 * The worker's HTTP surface: health, metrics, and a tick endpoint.
 *
 * /tick exists so n8n (or a cron, or a human) can nudge the loop awake. It is
 * deliberately incapable of causing a send: all it does is shorten the wait
 * before the next claim_email_jobs() call, which still applies every
 * authorization check.
 */
import express, { type Express } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getQueueHealth, type Logger, type Pool } from '@campaign/core';
import type { Worker } from './worker.js';

export interface ServerDeps {
  worker: Worker;
  db: Pool;
  logger: Logger;
  tickToken: string;
  workerId: string;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function createServer(deps: ServerDeps): Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.disable('x-powered-by');

  app.get('/health', async (_req, res) => {
    try {
      const health = await getQueueHealth(deps.db);
      const leaseBacklog = health.expired_leases;
      // Degraded rather than unhealthy: the system is safe, but something needs
      // attention and a load balancer should not necessarily kill the process.
      const degraded =
        leaseBacklog > 0 || health.needs_reconciliation > 0 || health.open_critical_alerts > 0;

      res.status(200).json({
        status: degraded ? 'degraded' : 'ok',
        worker_id: deps.workerId,
        running: deps.worker.isRunning(),
        database: 'ok',
        queue: health,
      });
    } catch (err) {
      res.status(503).json({
        status: 'unhealthy',
        worker_id: deps.workerId,
        database: 'unreachable',
        error: (err as Error).message,
      });
    }
  });

  app.get('/metrics', (_req, res) => {
    res.setHeader('content-type', 'text/plain; version=0.0.4');
    res.send(deps.worker.metrics.render());
  });

  app.post('/tick', (req, res) => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!deps.tickToken || !safeEqual(token, deps.tickToken)) {
      deps.logger.warn({ ip: req.ip }, 'rejected /tick with a bad token');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    deps.worker.tick();
    // Being explicit in the response matters: whoever calls this should never
    // believe they have caused an email to be sent.
    res.json({
      ok: true,
      note: 'Poll loop woken. This does not authorize any send; every job is still checked by the database.',
    });
  });

  app.use((_req, res) => res.status(404).json({ error: 'not found' }));

  return app;
}
