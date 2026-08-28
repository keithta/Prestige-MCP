/**
 * Structured logging.
 *
 * Recipient addresses are HASHED in logs. Logs travel to places the database
 * does not (files, aggregators, terminals over a shoulder); the full address
 * lives in Postgres, where it is access-controlled.
 */
import { createHash } from 'node:crypto';
import pino, { type Logger } from 'pino';

export type { Logger };

export function hashEmail(email: string | null | undefined): string {
  if (!email) return 'none';
  const normalized = email.trim().toLowerCase();
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  const domain = normalized.includes('@') ? normalized.split('@')[1] : 'invalid';
  // Domain is retained: it is operationally essential (a whole tenant bouncing
  // is a different problem from one bad address) and is not personal on its own.
  return `sha256:${digest}@${domain}`;
}

const REDACTED = '[redacted]';

export function createLogger(options?: { level?: string; name?: string }): Logger {
  return pino({
    name: options?.name ?? 'campaign',
    level: options?.level ?? process.env.LOG_LEVEL ?? 'info',
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'password', '*.password',
        'secret', '*.secret',
        'token', '*.token',
        'access_token', '*.access_token',
        'authorization', '*.authorization',
        'headers.authorization',
        'client_secret', '*.client_secret',
        'GRAPH_CLIENT_SECRET',
        'SUPABASE_SERVICE_ROLE_KEY',
        'DATABASE_URL',
      ],
      censor: REDACTED,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

export const logger = createLogger();
