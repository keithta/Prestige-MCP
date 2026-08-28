'use server';

import { z } from 'zod';
import { mutate, type ActionResult } from './shared';
import { hashPassword, signIn as doSignIn, signOut as doSignOut } from '../auth';
import { asService } from '../db';
import { redirect } from 'next/navigation';

const uuid = z.string().uuid();

/**
 * The global emergency stop. Requires a typed confirmation and a reason, both
 * because this is the control an operator reaches for when something is going
 * wrong and the record matters, and because it should never be a stray click.
 */
export async function setEmergencyStop(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'operator',
      revalidate: ['/', '/settings', '/campaigns'],
      input,
      schema: z.discriminatedUnion('engaged', [
        z.object({
          engaged: z.literal(true),
          reason: z.string().trim().min(3, 'Say why, for the audit trail').max(1000),
          confirmation: z.literal('STOP EVERYTHING'),
        }),
        z.object({
          engaged: z.literal(false),
          confirmation: z.literal('RESUME'),
        }),
      ]),
    },
    async (v, { query }) => {
      await query.query('SELECT campaign.set_emergency_stop($1, $2)', [
        v.engaged,
        v.engaged ? v.reason : null,
      ]);
    },
  );
}

/**
 * The production-mode gate. Owner only: this is the switch that lets a campaign
 * reach an address that is not on the test allowlist.
 */
export async function setProductionMode(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'owner',
      revalidate: ['/', '/settings'],
      input,
      schema: z.object({
        enabled: z.boolean(),
        reason: z.string().trim().max(1000).optional(),
        confirmation: z.literal('ENABLE PRODUCTION SENDING').optional(),
      }).refine(
        (v) => !v.enabled || v.confirmation === 'ENABLE PRODUCTION SENDING',
        { message: 'Type the confirmation phrase to enable production sending.', path: ['confirmation'] },
      ),
    },
    async (v, { query }) => {
      await query.query('SELECT campaign.set_production_mode($1, $2)', [
        v.enabled,
        v.reason ?? null,
      ]);
    },
  );
}

export async function setGlobalSendEnabled(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'owner',
      revalidate: ['/', '/settings'],
      input,
      schema: z.object({ enabled: z.boolean() }),
    },
    async (v, { query }) => {
      await query.query(
        `UPDATE campaign.system_controls
            SET global_send_enabled = $1, updated_at = now(), updated_by = campaign.current_user_id()
          WHERE id`,
        [v.enabled],
      );
      await query.query('SELECT campaign.write_audit($1, $2, $3)', [
        v.enabled ? 'system.sending_enabled' : 'system.sending_disabled',
        'system_controls',
        'singleton',
      ]);
    },
  );
}

export async function setSenderStatus(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'owner',
      revalidate: ['/settings', '/'],
      input,
      schema: z.object({
        senderId: uuid,
        status: z.enum(['active', 'paused', 'disabled']),
        reason: z.string().trim().max(500).optional(),
      }),
    },
    async (v, { query }) => {
      await query.query('SELECT campaign.set_sender_status($1, $2, $3)', [
        v.senderId, v.status, v.reason ?? null,
      ]);
    },
  );
}

export async function createSender(input: unknown): Promise<ActionResult<{ id: string }>> {
  return mutate(
    {
      role: 'owner',
      revalidate: ['/settings'],
      input,
      schema: z.object({
        mailboxAddress: z.string().trim().email(),
        displayName: z.string().trim().max(200).optional(),
        tenantId: z.string().trim().max(200).optional(),
        timezone: z.string().min(1).default('UTC'),
        hourlyLimit: z.coerce.number().int().min(1).max(10_000).default(60),
        dailyLimit: z.coerce.number().int().min(1).max(100_000).default(500),
        minIntervalSeconds: z.coerce.number().int().min(0).max(3600).default(4),
      }),
    },
    async (v, { query }) => {
      const { rows } = await query.query<{ id: string }>(
        `INSERT INTO campaign.sender_accounts
           (mailbox_address, display_name, tenant_id, timezone,
            hourly_limit, daily_limit, min_interval_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          v.mailboxAddress, v.displayName ?? null, v.tenantId ?? null, v.timezone,
          v.hourlyLimit, v.dailyLimit, v.minIntervalSeconds,
        ],
      );
      return { id: rows[0]!.id };
    },
  );
}

export async function addTestRecipient(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'owner',
      revalidate: ['/settings'],
      input,
      schema: z.object({
        email: z.string().trim().email(),
        note: z.string().trim().max(500).optional(),
      }),
    },
    async (v, { query }) => {
      await query.query(
        `INSERT INTO campaign.test_recipients (email_canonical, note, created_by)
         VALUES (campaign.canonical_email($1), $2, campaign.current_user_id())
         ON CONFLICT (email_canonical) DO NOTHING`,
        [v.email, v.note ?? null],
      );
    },
  );
}

export async function removeTestRecipient(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    { role: 'owner', revalidate: ['/settings'], input, schema: z.object({ id: uuid }) },
    async (v, { query }) => {
      await query.query('DELETE FROM campaign.test_recipients WHERE id = $1', [v.id]);
    },
  );
}

export async function setComplianceSettings(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'owner',
      revalidate: ['/settings'],
      input,
      schema: z.object({
        orgName: z.string().trim().min(1).max(200),
        // Legally required in the footer of every campaign; approval is blocked
        // without it.
        postalAddress: z.string().trim().min(5).max(500),
        replyTo: z.string().trim().email().optional().or(z.literal('')),
        appBaseUrl: z.string().trim().url(),
      }),
    },
    async (v, { query }) => {
      await query.query(
        `UPDATE campaign.compliance_settings
            SET org_name = $1, postal_address = $2,
                reply_to = NULLIF($3, '')::citext, app_base_url = $4,
                updated_at = now(), updated_by = campaign.current_user_id()
          WHERE id`,
        [v.orgName, v.postalAddress, v.replyTo ?? '', v.appBaseUrl.replace(/\/+$/, '')],
      );
    },
  );
}

export async function acknowledgeAlert(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'operator',
      revalidate: ['/'],
      input,
      schema: z.object({ id: z.coerce.number().int().positive() }),
    },
    async (v, { query }) => {
      await query.query(
        `UPDATE campaign.alerts
            SET acknowledged_at = now(), acknowledged_by = campaign.current_user_id()
          WHERE id = $1 AND acknowledged_at IS NULL`,
        [v.id],
      );
    },
  );
}

export async function resolveAlert(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'operator',
      revalidate: ['/'],
      input,
      schema: z.object({ id: z.coerce.number().int().positive() }),
    },
    async (v, { query }) => {
      await query.query(
        'UPDATE campaign.alerts SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL',
        [v.id],
      );
    },
  );
}

// --- authentication ---------------------------------------------------------

export async function signInAction(
  _prev: unknown,
  formData: FormData,
): Promise<{ error?: string }> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  if (!email || !password) return { error: 'Enter your email and password.' };

  const session = await doSignIn(email, password);
  // One message for both cases: a wrong password and a missing account must be
  // indistinguishable.
  if (!session) return { error: 'Incorrect email or password.' };

  await asService((client) =>
    client.query('UPDATE campaign.app_profiles SET last_login_at = now() WHERE id = $1', [
      session.userId,
    ]),
  );
  redirect('/');
}

export async function signOutAction(): Promise<void> {
  await doSignOut();
  redirect('/login');
}

export async function createOperator(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'owner',
      revalidate: ['/settings'],
      input,
      schema: z.object({
        email: z.string().trim().email(),
        password: z.string().min(12, 'Use at least 12 characters').max(200),
        role: z.enum(['owner', 'approver', 'operator', 'viewer']),
        fullName: z.string().trim().max(200).optional(),
      }),
    },
    async (v, { query }) => {
      const hash = await hashPassword(v.password);
      await query.query('SELECT campaign.create_operator($1, $2, $3, $4)', [
        v.email, hash, v.role, v.fullName ?? null,
      ]);
    },
  );
}
