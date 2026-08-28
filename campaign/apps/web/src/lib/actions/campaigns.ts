'use server';

import { z } from 'zod';
import { mutate, type ActionResult } from './shared';

const uuid = z.string().uuid();

export async function createCampaign(input: unknown): Promise<ActionResult<{ id: string }>> {
  return mutate(
    {
      role: 'operator',
      revalidate: ['/campaigns'],
      input,
      schema: z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2000).optional(),
        senderAccountId: uuid,
        // A campaign starts in test mode. Reaching real recipients takes two
        // deliberate switches, and this is the first of them.
        sendMode: z.enum(['test', 'production']).default('test'),
        targetCount: z.coerce.number().int().positive().nullable().optional(),
      }),
    },
    async (v, { query }) => {
      const { rows } = await query.query<{ id: string }>(
        `INSERT INTO campaign.campaigns
           (name, description, sender_account_id, send_mode, target_count, created_by)
         VALUES ($1, $2, $3, $4, $5, campaign.current_user_id())
         RETURNING id`,
        [v.name, v.description ?? null, v.senderAccountId, v.sendMode, v.targetCount ?? null],
      );
      return { id: rows[0]!.id };
    },
  );
}

export async function setContent(input: unknown): Promise<ActionResult<{ versionId: string }>> {
  return mutate(
    {
      role: 'operator',
      revalidate: ['/campaigns'],
      input,
      schema: z.object({
        campaignId: uuid,
        subject: z.string().trim().min(1).max(500),
        bodyHtml: z.string().max(500_000).optional(),
        bodyText: z.string().max(500_000).optional(),
      }),
    },
    async (v, { query }) => {
      // Sanitization happens here rather than at render time: the stored body is
      // shown in the admin preview, so unsanitized markup would be stored XSS
      // against the operator's own session.
      const { sanitizeEmailHtml, htmlToPlainText } = await import('@campaign/core');
      const html = v.bodyHtml ? sanitizeEmailHtml(v.bodyHtml) : null;
      const text = v.bodyText?.trim() ? v.bodyText : html ? htmlToPlainText(html) : null;

      const { rows } = await query.query<{ set_campaign_content: string }>(
        'SELECT campaign.set_campaign_content($1, $2, $3, $4) AS set_campaign_content',
        [v.campaignId, v.subject, html, text],
      );
      return { versionId: rows[0]!.set_campaign_content };
    },
  );
}

export async function setSchedule(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'operator',
      revalidate: ['/campaigns'],
      input,
      schema: z.object({
        campaignId: uuid,
        timezone: z.string().min(1),
        allowedDays: z.array(z.coerce.number().int().min(1).max(7)).min(1).max(7),
        windowStart: z.string().regex(/^\d{2}:\d{2}$/),
        windowEnd: z.string().regex(/^\d{2}:\d{2}$/),
        emailsPerHour: z.coerce.number().int().min(1).max(10_000),
        emailsPerDay: z.coerce.number().int().min(1).max(100_000),
        minGapSeconds: z.coerce.number().int().min(0).max(3600),
        startAt: z.string().datetime().nullable().optional(),
        endAt: z.string().datetime().nullable().optional(),
      }),
    },
    async (v, { query }) => {
      await query.query(
        `INSERT INTO campaign.campaign_schedules
           (campaign_id, timezone, allowed_days, window_start, window_end,
            emails_per_hour, emails_per_day, min_gap_seconds, start_at, end_at)
         VALUES ($1, $2, $3::smallint[], $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (campaign_id) DO UPDATE SET
           timezone = EXCLUDED.timezone,
           allowed_days = EXCLUDED.allowed_days,
           window_start = EXCLUDED.window_start,
           window_end = EXCLUDED.window_end,
           emails_per_hour = EXCLUDED.emails_per_hour,
           emails_per_day = EXCLUDED.emails_per_day,
           min_gap_seconds = EXCLUDED.min_gap_seconds,
           start_at = EXCLUDED.start_at,
           end_at = EXCLUDED.end_at`,
        [
          v.campaignId, v.timezone, v.allowedDays, v.windowStart, v.windowEnd,
          v.emailsPerHour, v.emailsPerDay, v.minGapSeconds,
          v.startAt ?? null, v.endAt ?? null,
        ],
      );
    },
  );
}

export async function setRecipients(input: unknown): Promise<ActionResult<{ added: number }>> {
  return mutate(
    {
      role: 'operator',
      revalidate: ['/campaigns'],
      input,
      schema: z.object({
        campaignId: uuid,
        listIds: z.array(uuid).default([]),
        contactIds: z.array(uuid).default([]),
        replace: z.boolean().default(true),
      }),
    },
    async (v, { query }) => {
      if (v.replace) {
        // Only the audience is reset; jobs already created are untouched, and
        // the unique constraints stop a removed-then-re-added contact from
        // receiving a second email.
        await query.query('DELETE FROM campaign.campaign_recipients WHERE campaign_id = $1', [
          v.campaignId,
        ]);
      }
      const { rows } = await query.query<{ n: string }>(
        `WITH candidates AS (
           SELECT DISTINCT c.id
             FROM campaign.contacts c
             LEFT JOIN campaign.contact_list_members m ON m.contact_id = c.id
            WHERE c.deleted_at IS NULL
              AND c.status = 'active'
              AND (m.list_id = ANY($2::uuid[]) OR c.id = ANY($3::uuid[]))
         ),
         ordered AS (
           SELECT id, row_number() OVER (ORDER BY id) AS position FROM candidates
         ),
         inserted AS (
           INSERT INTO campaign.campaign_recipients (campaign_id, contact_id, position, added_by)
           SELECT $1, id, position, campaign.current_user_id() FROM ordered
           ON CONFLICT (campaign_id, contact_id) DO NOTHING
           RETURNING 1
         )
         SELECT count(*)::text AS n FROM inserted`,
        [v.campaignId, v.listIds, v.contactIds],
      );
      return { added: Number(rows[0]!.n) };
    },
  );
}

export async function approveCampaign(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      // Approval is the moment a campaign becomes sendable, so it needs more
      // than operator.
      role: 'approver',
      revalidate: ['/campaigns'],
      input,
      schema: z.object({
        campaignId: uuid,
        note: z.string().trim().max(1000).optional(),
        // Typed confirmation: approval should never be a stray click.
        confirmation: z.literal('APPROVE'),
      }),
    },
    async (v, { query }) => {
      await query.query('SELECT campaign.approve_campaign($1, $2)', [v.campaignId, v.note ?? null]);
      await query.query('SELECT * FROM campaign.materialize_campaign_jobs($1)', [v.campaignId]);
    },
  );
}

export async function materializeCampaign(input: unknown): Promise<
  ActionResult<{ created: number; suppressed: number; skippedDuplicate: number }>
> {
  return mutate(
    {
      role: 'operator',
      revalidate: ['/campaigns'],
      input,
      schema: z.object({ campaignId: uuid }),
    },
    async (v, { query }) => {
      const { rows } = await query.query<{
        created: number; suppressed: number; skipped_duplicate: number;
      }>('SELECT * FROM campaign.materialize_campaign_jobs($1)', [v.campaignId]);
      return {
        created: Number(rows[0]!.created),
        suppressed: Number(rows[0]!.suppressed),
        skippedDuplicate: Number(rows[0]!.skipped_duplicate),
      };
    },
  );
}

const controlSchema = z.object({
  campaignId: uuid,
  reason: z.string().trim().max(1000).optional(),
});

export async function startCampaign(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    { role: 'operator', revalidate: ['/campaigns', '/'], input, schema: controlSchema },
    async (v, { query }) => {
      await query.query('SELECT campaign.start_campaign($1)', [v.campaignId]);
    },
  );
}

export async function pauseCampaign(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    { role: 'operator', revalidate: ['/campaigns', '/'], input, schema: controlSchema },
    async (v, { query }) => {
      await query.query('SELECT campaign.pause_campaign($1, $2)', [v.campaignId, v.reason ?? null]);
    },
  );
}

export async function resumeCampaign(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    { role: 'operator', revalidate: ['/campaigns', '/'], input, schema: controlSchema },
    async (v, { query }) => {
      await query.query('SELECT campaign.resume_campaign($1)', [v.campaignId]);
    },
  );
}

export async function stopCampaign(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'operator',
      revalidate: ['/campaigns', '/'],
      input,
      // Stopping cancels every unsent email and cannot be undone, so it asks
      // for the campaign name to be typed.
      schema: controlSchema.extend({ confirmation: z.literal('STOP') }),
    },
    async (v, { query }) => {
      await query.query('SELECT campaign.stop_campaign($1, $2)', [v.campaignId, v.reason ?? null]);
    },
  );
}

export async function requeueJob(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'operator',
      revalidate: ['/campaigns'],
      input,
      schema: z.object({ jobId: uuid, reason: z.string().trim().min(1).max(500) }),
    },
    async (v, { query }) => {
      await query.query('SELECT campaign.requeue_job($1, $2)', [v.jobId, v.reason]);
    },
  );
}
