'use server';

import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { mutate, type ActionResult } from './shared';
import type { ImportPreview } from './types';

const uuid = z.string().uuid();
const EMAIL = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 200_000;

/**
 * Parse and analyse a CSV without writing anything.
 *
 * The operator sees exactly what a commit would do -- how many rows are valid,
 * which are malformed, which are already present, and which are suppressed --
 * before any contact is created.
 */
export async function previewImport(input: unknown): Promise<ActionResult<ImportPreview>> {
  return mutate(
    {
      role: 'operator',
      input,
      schema: z.object({
        csv: z.string().max(MAX_BYTES),
        mapping: z.record(z.string()).default({}),
      }),
    },
    async (v, { query }) => {
      const rows = parseCsv(v.csv);
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
      const mapping: Record<string, string> = v.mapping ?? {};
      const emailColumn = mapping.email ?? guessEmailColumn(columns);

      const preview: ImportPreview = {
        batchId: null,
        totalRows: rows.length,
        valid: 0,
        invalid: 0,
        duplicatesInFile: 0,
        alreadyPresent: 0,
        suppressed: 0,
        errors: [],
        sample: rows.slice(0, 5),
        columns,
      };

      if (!emailColumn) {
        preview.invalid = rows.length;
        preview.errors.push({ row: 0, value: '', reason: 'No email column could be identified.' });
        return preview;
      }

      const seen = new Set<string>();
      const candidates: string[] = [];

      for (const [i, row] of rows.entries()) {
        const raw = (row[emailColumn] ?? '').trim();
        const canonical = raw.toLowerCase();

        if (!raw || !EMAIL.test(raw)) {
          preview.invalid += 1;
          if (preview.errors.length < 100) {
            preview.errors.push({
              row: i + 2, // +2: 1-based, plus the header row
              value: raw,
              reason: raw ? 'Not a valid email address.' : 'Email is blank.',
            });
          }
          continue;
        }
        if (seen.has(canonical)) {
          preview.duplicatesInFile += 1;
          continue;
        }
        seen.add(canonical);
        candidates.push(canonical);
        preview.valid += 1;
      }

      if (candidates.length > 0) {
        const { rows: existing } = await query.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM campaign.contacts
            WHERE email_canonical = ANY($1::citext[])`,
          [candidates],
        );
        preview.alreadyPresent = Number(existing[0]!.n);

        const { rows: blocked } = await query.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM campaign.suppressions
            WHERE revoked_at IS NULL AND scope = 'global'
              AND email_canonical = ANY($1::citext[])`,
          [candidates],
        );
        preview.suppressed = Number(blocked[0]!.n);
      }

      return preview;
    },
  );
}

/**
 * Commit an import. One transaction: either every valid row lands or none does.
 * Suppressed addresses are imported and FLAGGED rather than dropped, so the
 * operator can see they were on the list and why they will not be contacted.
 */
export async function commitImport(input: unknown): Promise<ActionResult<ImportPreview>> {
  return mutate(
    {
      role: 'operator',
      revalidate: ['/contacts'],
      input,
      schema: z.object({
        csv: z.string().max(MAX_BYTES),
        filename: z.string().max(400).optional(),
        mapping: z.record(z.string()).default({}),
        listName: z.string().trim().max(200).optional(),
        source: z.string().trim().max(200).optional(),
        consentNote: z.string().trim().max(1000).optional(),
      }),
    },
    async (v, { query }) => {
      const rows = parseCsv(v.csv);
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
      const mapping: Record<string, string> = v.mapping ?? {};
      const map = {
        email: mapping.email ?? guessEmailColumn(columns) ?? '',
        first_name: mapping.first_name ?? guess(columns, ['first_name', 'firstname', 'first', 'given name']),
        last_name: mapping.last_name ?? guess(columns, ['last_name', 'lastname', 'last', 'surname']),
        company: mapping.company ?? guess(columns, ['company', 'organization', 'organisation', 'account']),
        job_title: mapping.job_title ?? guess(columns, ['job_title', 'title', 'role', 'position']),
        phone: mapping.phone ?? guess(columns, ['phone', 'telephone', 'mobile']),
      };
      if (!map.email) throw new Error('No email column could be identified in the file.');

      const { rows: batchRows } = await query.query<{ id: string }>(
        `INSERT INTO campaign.import_batches
           (filename, status, dry_run, total_rows, column_mapping, uploaded_by)
         VALUES ($1, 'analyzing', false, $2, $3, campaign.current_user_id())
         RETURNING id`,
        [v.filename ?? null, rows.length, JSON.stringify(map)],
      );
      const batchId = batchRows[0]!.id;

      let listId: string | null = null;
      if (v.listName) {
        const { rows: listRows } = await query.query<{ id: string }>(
          `INSERT INTO campaign.contact_lists (name, created_by)
           VALUES ($1, campaign.current_user_id())
           ON CONFLICT DO NOTHING RETURNING id`,
          [v.listName],
        );
        listId =
          listRows[0]?.id ??
          (
            await query.query<{ id: string }>(
              'SELECT id FROM campaign.contact_lists WHERE lower(name) = lower($1) AND archived_at IS NULL',
              [v.listName],
            )
          ).rows[0]?.id ??
          null;
      }

      const result: ImportPreview = {
        batchId, totalRows: rows.length, valid: 0, invalid: 0,
        duplicatesInFile: 0, alreadyPresent: 0, suppressed: 0,
        errors: [], sample: rows.slice(0, 5), columns,
      };

      const seen = new Set<string>();
      const known = new Set(['email', 'first_name', 'last_name', 'company', 'job_title', 'phone']);
      const mapped = new Set(Object.values(map).filter(Boolean) as string[]);

      for (const [i, row] of rows.entries()) {
        const raw = (row[map.email] ?? '').trim();
        const canonical = raw.toLowerCase();

        if (!raw || !EMAIL.test(raw)) {
          result.invalid += 1;
          await query.query(
            `INSERT INTO campaign.import_errors (batch_id, row_number, raw_row, error_code, error_message)
             VALUES ($1, $2, $3, $4, $5)`,
            [batchId, i + 2, JSON.stringify(row), 'invalid_email',
             raw ? `"${raw}" is not a valid email address` : 'Email is blank'],
          );
          continue;
        }
        if (seen.has(canonical)) {
          result.duplicatesInFile += 1;
          continue;
        }
        seen.add(canonical);

        // Unmapped columns are kept as merge-field attributes rather than
        // discarded, so a list can carry whatever the operator needs.
        const attributes: Record<string, string> = {};
        for (const [key, value] of Object.entries(row)) {
          if (!mapped.has(key) && !known.has(key) && value?.trim()) {
            attributes[key.trim().toLowerCase().replace(/\s+/g, '_')] = value.trim();
          }
        }

        const { rows: upserted } = await query.query<{ id: string; inserted: boolean }>(
          `INSERT INTO campaign.contacts
             (email, first_name, last_name, company, job_title, phone,
              attributes, source, consent_note, import_batch_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, campaign.current_user_id())
           ON CONFLICT (email_canonical) DO UPDATE SET
             first_name = COALESCE(EXCLUDED.first_name, campaign.contacts.first_name),
             last_name  = COALESCE(EXCLUDED.last_name,  campaign.contacts.last_name),
             company    = COALESCE(EXCLUDED.company,    campaign.contacts.company),
             job_title  = COALESCE(EXCLUDED.job_title,  campaign.contacts.job_title),
             phone      = COALESCE(EXCLUDED.phone,      campaign.contacts.phone),
             attributes = campaign.contacts.attributes || EXCLUDED.attributes
           RETURNING id, (xmax = 0) AS inserted`,
          [
            raw,
            nullable(row[map.first_name ?? '']),
            nullable(row[map.last_name ?? '']),
            nullable(row[map.company ?? '']),
            nullable(row[map.job_title ?? '']),
            nullable(row[map.phone ?? '']),
            JSON.stringify(attributes),
            v.source ?? v.filename ?? 'csv_import',
            v.consentNote ?? null,
            batchId,
          ],
        );

        const contact = upserted[0]!;
        if (contact.inserted) result.valid += 1;
        else result.alreadyPresent += 1;

        if (listId) {
          await query.query(
            `INSERT INTO campaign.contact_list_members (list_id, contact_id, added_by)
             VALUES ($1, $2, campaign.current_user_id()) ON CONFLICT DO NOTHING`,
            [listId, contact.id],
          );
        }
      }

      const { rows: blocked } = await query.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM campaign.suppressions
          WHERE revoked_at IS NULL AND scope = 'global'
            AND email_canonical = ANY($1::citext[])`,
        [[...seen]],
      );
      result.suppressed = Number(blocked[0]!.n);

      await query.query(
        `UPDATE campaign.import_batches
            SET status = 'committed', inserted_count = $2, updated_count = $3,
                error_count = $4, skipped_count = $5, suppressed_count = $6,
                target_list_id = $7, completed_at = now()
          WHERE id = $1`,
        [batchId, result.valid, result.alreadyPresent, result.invalid,
         result.duplicatesInFile, result.suppressed, listId],
      );

      return result;
    },
  );
}

export async function addSuppression(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'operator',
      revalidate: ['/suppressions'],
      input,
      schema: z.object({
        email: z.string().trim().regex(EMAIL, 'Not a valid email address'),
        reason: z.enum([
          'unsubscribe', 'bounce_hard', 'bounce_soft', 'complaint',
          'manual', 'domain_block', 'invalid_address',
        ]),
        notes: z.string().trim().max(1000).optional(),
      }),
    },
    async (v, { query }) => {
      await query.query('SELECT campaign.add_suppression($1, $2, $3, $4, $5, $6)', [
        v.email, v.reason, 'global', null, 'manual', v.notes ?? null,
      ]);
    },
  );
}

export async function revokeSuppression(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'owner',
      revalidate: ['/suppressions'],
      input,
      schema: z.object({ id: uuid, reason: z.string().trim().min(1).max(500) }),
    },
    async (v, { query }) => {
      await query.query('SELECT campaign.revoke_suppression($1, $2)', [v.id, v.reason]);
    },
  );
}

export async function deleteContact(input: unknown): Promise<ActionResult<void>> {
  return mutate(
    {
      role: 'operator',
      revalidate: ['/contacts'],
      input,
      schema: z.object({ id: uuid }),
    },
    async (v, { query }) => {
      // Soft delete: the row stays so the address remains claimed and a
      // re-import cannot resurrect it as a brand-new contact.
      await query.query(
        "UPDATE campaign.contacts SET deleted_at = now(), status = 'deleted' WHERE id = $1",
        [v.id],
      );
    },
  );
}

// --- helpers ---------------------------------------------------------------

function parseCsv(csv: string): Array<Record<string, string>> {
  const rows = parse(csv, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  }) as Array<Record<string, string>>;

  if (rows.length > MAX_ROWS) {
    throw new Error(`File has ${rows.length} rows; the limit is ${MAX_ROWS}.`);
  }
  return rows;
}

function guess(columns: string[], candidates: string[]): string | undefined {
  return columns.find((c) => candidates.includes(c.trim().toLowerCase()));
}

function guessEmailColumn(columns: string[]): string | undefined {
  return guess(columns, ['email', 'email_address', 'e-mail', 'emailaddress', 'mail']);
}

function nullable(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
