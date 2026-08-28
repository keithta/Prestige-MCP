/** Worker entry point. */
import { config as loadDotenv } from 'dotenv';
import {
  closePool,
  createLogger,
  getPool,
  loadDatabaseConfig,
  loadGraphConfig,
  loadWorkerConfig,
  ConfigError,
} from '@campaign/core';
import { Worker } from './worker.js';
import { createServer } from './server.js';

loadDotenv({ path: process.env.ENV_FILE ?? '.env' });

async function main(): Promise<void> {
  const logger = createLogger({ name: 'worker' });

  let dbConfig, graphConfig, workerConfig;
  try {
    dbConfig = loadDatabaseConfig();
    graphConfig = loadGraphConfig();
    workerConfig = loadWorkerConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Fail at boot with an exact list, rather than at 2am mid-campaign.
      logger.fatal(err.message);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  const db = getPool(dbConfig.DATABASE_URL, dbConfig.DATABASE_POOL_MAX);
  await db.query('SELECT 1');
  logger.info('database reachable');

  const worker = new Worker({ db, config: workerConfig, graphConfig, logger });
  const app = createServer({
    worker, db, logger,
    tickToken: workerConfig.WORKER_TICK_TOKEN,
    workerId: workerConfig.WORKER_ID,
  });

  const server = app.listen(workerConfig.WORKER_PORT, () => {
    logger.info({ port: workerConfig.WORKER_PORT }, 'worker HTTP listening');
  });

  await worker.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown requested');
    server.close();
    await worker.stop();
    await closePool();
    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: String(reason) }, 'unhandled rejection');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
