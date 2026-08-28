/**
 * Shared plumbing for server actions.
 *
 * Every mutation follows the same shape: validate input with Zod, check the
 * caller's role, then call a database function that performs the change and
 * writes its own audit row. Keeping the audit write inside the database
 * function means no caller can forget it.
 */
import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { asUser } from '../db';
import { requireRole, type Session } from '../auth';
import type { AppRole } from '@campaign/core';

export interface ActionResult<T = void> {
  ok: boolean;
  error?: string;
  data?: T;
}

export function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

export function succeed<T>(data?: T): ActionResult<T> {
  return data === undefined ? { ok: true } : { ok: true, data };
}

/** Result of an action that has no payload. */
export type VoidResult = ActionResult<void>;

/**
 * Turn a database error into something an operator can act on. The raw text of
 * a Postgres exception is accurate but not helpful, and it can leak schema
 * detail into the UI.
 */
export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  if (/fails compliance checks/.test(message)) {
    const issues = message.split('compliance checks: ')[1] ?? '';
    const friendly: Record<string, string> = {
      missing_unsubscribe: 'the body has no unsubscribe link',
      missing_postal_address: 'the body has no postal address',
      missing_schedule: 'the campaign has no schedule',
      no_recipients: 'the campaign has no recipients',
      no_content_version: 'the campaign has no content',
    };
    const listed = issues
      .split(',')
      .map((i) => friendly[i.trim()] ?? i.trim())
      .join('; ');
    return `This campaign cannot be approved because ${listed}.`;
  }

  if (/duplicate key value violates unique constraint "contacts_email_canonical_key"/.test(message)) {
    return 'That email address already exists in your contacts.';
  }
  if (/email_jobs_one_live_per_recipient/.test(message)) {
    return 'That address already has an email queued for this campaign.';
  }
  if (/illegal email_jobs transition/.test(message)) {
    return 'That change is not allowed for a job in its current state.';
  }
  if (/append-only/.test(message)) {
    return 'The audit trail cannot be modified.';
  }
  if (/permission denied|insufficient_privilege|row-level security/i.test(message)) {
    return 'Your account does not have permission to do that.';
  }
  if (/cannot be revoked/.test(message)) {
    return 'Suppressions created by an unsubscribe or a spam complaint cannot be removed.';
  }
  if (/app_base_url must be set|postal_address must be set/.test(message)) {
    return 'Set your organisation name, postal address, and application URL in Settings first.';
  }
  return message.replace(/^error:\s*/i, '');
}

/**
 * Wrap a mutation: role check, validation, execution as the acting user (so RLS
 * applies), error translation, and cache revalidation.
 */
export async function mutate<TInput, TOutput>(
  opts: {
    role: AppRole;
    schema: z.ZodType<TInput>;
    input: unknown;
    revalidate?: string[];
  },
  run: (
    input: TInput,
    ctx: { session: Session; query: Parameters<Parameters<typeof asUser>[1]>[0] },
  ) => Promise<TOutput>,
): Promise<ActionResult<TOutput>> {
  let session: Session;
  try {
    session = await requireRole(opts.role);
  } catch (err) {
    return fail((err as Error).message);
  }

  const parsed = opts.schema.safeParse(opts.input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input.');
  }

  try {
    const data = await asUser(session.userId, (client) =>
      run(parsed.data, { session, query: client }),
    );
    for (const path of opts.revalidate ?? []) revalidatePath(path);
    return succeed(data);
  } catch (err) {
    return fail(describeError(err));
  }
}
