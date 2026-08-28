/**
 * Check the environment before anything starts.
 *
 *   npm run verify-env            check everything
 *   npm run verify-env -- worker  check only what the worker needs
 */
import { config } from 'dotenv';
import {
  ConfigError, loadAppConfig, loadDatabaseConfig, loadGraphConfig, loadWorkerConfig,
} from '@campaign/core';

config({ path: process.env.ENV_FILE ?? '.env', override: false });

type Check = { name: string; run: () => unknown };

const CHECKS: Record<string, Check[]> = {
  database: [{ name: 'Database', run: loadDatabaseConfig }],
  graph: [{ name: 'Microsoft Graph', run: loadGraphConfig }],
  worker: [
    { name: 'Database', run: loadDatabaseConfig },
    { name: 'Microsoft Graph', run: loadGraphConfig },
    { name: 'Worker', run: loadWorkerConfig },
  ],
  web: [
    { name: 'Database', run: loadDatabaseConfig },
    { name: 'Application', run: loadAppConfig },
    {
      name: 'Web session',
      run: () => {
        if (!process.env.SESSION_SECRET && !process.env.UNSUBSCRIBE_HMAC_SECRET) {
          throw new ConfigError(
            'SESSION_SECRET is not set. Generate one with: openssl rand -hex 32',
            ['SESSION_SECRET'],
          );
        }
      },
    },
  ],
};
CHECKS.all = [...CHECKS.worker!, ...CHECKS.web!].filter(
  (check, i, all) => all.findIndex((c) => c.name === check.name) === i,
);

const scope = process.argv[2] ?? 'all';
const checks = CHECKS[scope];
if (!checks) {
  console.error(`unknown scope "${scope}". One of: ${Object.keys(CHECKS).join(', ')}`);
  process.exit(2);
}

let failed = 0;
for (const check of checks) {
  try {
    check.run();
    console.log(`  ok       ${check.name}`);
  } catch (err) {
    failed += 1;
    console.log(`  MISSING  ${check.name}`);
    console.log(
      `           ${(err instanceof Error ? err.message : String(err)).split('\n').join('\n           ')}`,
    );
  }
}

if (failed > 0) {
  console.log(`\n${failed} configuration problem(s). See .env.example and docs/ENVIRONMENT.md.`);
  process.exit(78); // EX_CONFIG
}
console.log('\nConfiguration looks complete.');
