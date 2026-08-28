/**
 * Forward-only migration runner.
 *
 * Applies every numbered .sql file in supabase/migrations exactly once, in
 * filename order, each inside its own transaction, recording the applied
 * version and a checksum. If a previously-applied file's contents change the
 * runner refuses to continue -- migrations are immutable once shipped.
 *
 *   npm run migrate                 apply pending migrations
 *   npm run migrate -- --status     list applied/pending without changing anything
 *   npm run migrate -- --dry-run    show what would run
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from 'dotenv';

config({ path: '.env', override: false });

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

interface Migration {
  version: string;
  name: string;
  path: string;
  sql: string;
  checksum: string;
}

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const path = join(MIGRATIONS_DIR, file);
      const sql = readFileSync(path, 'utf8');
      const version = file.split('_')[0] ?? file;
      return {
        version,
        name: file,
        path,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

const LEDGER = `
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version     text PRIMARY KEY,
    name        text NOT NULL,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL
  );
`;

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const statusOnly = args.has('--status');
  const dryRun = args.has('--dry-run');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. See .env.example.');
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString,
    // Supabase requires TLS; the local test cluster does not offer it.
    ssl: /supabase\.(co|com)/.test(connectionString) ? { rejectUnauthorized: true } : undefined,
  });
  await client.connect();

  try {
    await client.query(LEDGER);
    const { rows } = await client.query<{ version: string; checksum: string; name: string }>(
      'SELECT version, checksum, name FROM public.schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.version, r]));
    const migrations = loadMigrations();

    // Immutability check: a shipped migration must never be edited in place.
    for (const m of migrations) {
      const prior = applied.get(m.version);
      if (prior && prior.checksum !== m.checksum) {
        console.error(
          `\nREFUSING TO RUN: migration ${m.name} was already applied but its contents changed.\n` +
            `  applied checksum: ${prior.checksum}\n  current checksum: ${m.checksum}\n` +
            `Migrations are forward-only. Add a new migration instead of editing this one.\n`,
        );
        process.exit(1);
      }
    }

    const pending = migrations.filter((m) => !applied.has(m.version));

    if (statusOnly) {
      console.log(`\n  applied: ${applied.size}   pending: ${pending.length}\n`);
      for (const m of migrations) {
        console.log(`  ${applied.has(m.version) ? '✓' : ' '} ${m.name}`);
      }
      console.log('');
      return;
    }

    if (pending.length === 0) {
      console.log('No pending migrations. Database is up to date.');
      return;
    }

    for (const m of pending) {
      if (dryRun) {
        console.log(`  would apply ${m.name}`);
        continue;
      }
      const started = Date.now();
      process.stdout.write(`  applying ${m.name} ... `);
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query(
          'INSERT INTO public.schema_migrations (version, name, checksum, duration_ms) VALUES ($1,$2,$3,$4)',
          [m.version, m.name, m.checksum, Date.now() - started],
        );
        await client.query('COMMIT');
        console.log(`ok (${Date.now() - started}ms)`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        console.error(`\n${(err as Error).message}\n`);
        process.exit(1);
      }
    }
    if (!dryRun) console.log(`\nApplied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
