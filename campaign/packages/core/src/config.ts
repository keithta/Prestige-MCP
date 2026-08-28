/**
 * Environment loading and validation.
 *
 * Fails fast, at boot, with a precise list of what is missing -- rather than
 * failing at 2am on the first send because a variable was blank.
 */
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

/** Refuses obviously-placeholder values that would otherwise pass a min(1) check. */
const secret = nonEmpty.refine(
  (v) => !/^(changeme|todo|xxx+|your[-_]?\w+|<.*>)$/i.test(v),
  'looks like an unreplaced placeholder',
);

export const DatabaseConfigSchema = z.object({
  DATABASE_URL: nonEmpty.refine(
    (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
    'must be a postgres:// or postgresql:// connection string',
  ),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
});

export const GraphConfigSchema = z
  .object({
    GRAPH_TENANT_ID: nonEmpty,
    GRAPH_CLIENT_ID: nonEmpty,
    GRAPH_CLIENT_SECRET: secret.optional(),
    GRAPH_CLIENT_CERTIFICATE_PATH: z.string().trim().optional(),
    GRAPH_CLIENT_CERTIFICATE_PASSWORD: z.string().optional(),
    GRAPH_CLIENT_CERTIFICATE_THUMBPRINT: z.string().trim().optional(),
    GRAPH_BASE_URL: z.string().url().default('https://graph.microsoft.com/v1.0'),
    GRAPH_AUTHORITY_HOST: z.string().url().default('https://login.microsoftonline.com'),
    GRAPH_SEND_STRATEGY: z.enum(['draft_then_send', 'send_mail']).default('draft_then_send'),
    GRAPH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  })
  .refine(
    (c) => Boolean(c.GRAPH_CLIENT_SECRET) || Boolean(c.GRAPH_CLIENT_CERTIFICATE_PATH),
    {
      message:
        'Provide either GRAPH_CLIENT_SECRET (cloud dev) or GRAPH_CLIENT_CERTIFICATE_PATH (Windows production).',
      path: ['GRAPH_CLIENT_SECRET'],
    },
  );

export const WorkerConfigSchema = z.object({
  WORKER_ID: nonEmpty.default('worker-1'),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(600_000).default(5000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(10),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
  WORKER_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(1),
  WORKER_TICK_TOKEN: secret,
});

export const AppConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type GraphConfig = z.infer<typeof GraphConfigSchema>;
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

function parse<T extends z.ZodTypeAny>(
  schema: T,
  env: NodeJS.ProcessEnv,
  label: string,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new ConfigError(
      `${label} configuration is invalid:\n  - ${problems.join('\n  - ')}\n\nSee .env.example and docs/ENVIRONMENT.md.`,
      problems,
    );
  }
  return result.data;
}

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  return parse(DatabaseConfigSchema, env, 'Database');
}

export function loadGraphConfig(env: NodeJS.ProcessEnv = process.env): GraphConfig {
  const cfg = parse(GraphConfigSchema, env, 'Microsoft Graph');

  // A misconfigured GRAPH_BASE_URL in production would silently send real
  // campaign mail to a test double -- or worse, to somebody else's server.
  if (env.NODE_ENV === 'production' && !cfg.GRAPH_BASE_URL.startsWith('https://graph.microsoft.com')) {
    throw new ConfigError(
      `GRAPH_BASE_URL is "${cfg.GRAPH_BASE_URL}" but NODE_ENV=production. ` +
        'Overriding the Graph endpoint is only permitted outside production.',
      ['GRAPH_BASE_URL'],
    );
  }
  return cfg;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return parse(WorkerConfigSchema, env, 'Worker');
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return parse(AppConfigSchema, env, 'Application');
}
