'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  approveCampaign, materializeCampaign, pauseCampaign, requeueJob, resumeCampaign,
  setContent, setRecipients, setSchedule, startCampaign, stopCampaign,
} from '@/lib/actions/campaigns';
import { Button, Card, Field, inputClass } from '@/components/ui';

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success?: string) {
    setError(null);
    setMessage(null);
    start(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? 'Failed.');
      else {
        if (success) setMessage(success);
        router.refresh();
      }
    });
  }
  return { run, error, message, pending };
}

function Feedback({ error, message }: { error: string | null; message: string | null }) {
  if (error) {
    return (
      <p className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
        {error}
      </p>
    );
  }
  if (message) {
    return (
      <p className="mt-2 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
        {message}
      </p>
    );
  }
  return null;
}

export function ContentEditor({
  campaignId, subject, bodyHtml, bodyText, disabled,
}: {
  campaignId: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  disabled: boolean;
}) {
  const { run, error, message, pending } = useAction();
  const [html, setHtml] = useState(bodyHtml);

  return (
    <form
      action={(formData) =>
        run(
          () =>
            setContent({
              campaignId,
              subject: formData.get('subject'),
              bodyHtml: formData.get('bodyHtml'),
              bodyText: formData.get('bodyText'),
            }),
          'Content saved. Editing after approval revokes the approval.',
        )
      }
      className="space-y-4"
    >
      <Field label="Subject" hint="Merge fields: {{first_name}}, {{last_name}}, {{company}}, {{job_title}}. Use {{first_name|there}} for a fallback.">
        <input name="subject" defaultValue={subject} required disabled={disabled} className={inputClass} />
      </Field>

      <div className="grid gap-4 lg:grid-cols-2">
        <Field
          label="HTML body"
          hint="Must include {{unsubscribe_url}} and {{postal_address}} — approval is blocked without them."
        >
          <textarea
            name="bodyHtml"
            defaultValue={bodyHtml}
            onChange={(e) => setHtml(e.target.value)}
            disabled={disabled}
            rows={14}
            className={`${inputClass} font-mono text-xs`}
          />
        </Field>
        <div>
          <span className="mb-1 block text-xs font-medium text-slate-700">Preview</span>
          {/* Sandboxed: campaign HTML is operator-authored, but it is still
              untrusted markup being rendered inside an authenticated session. */}
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={html}
            className="h-[22rem] w-full rounded border border-slate-300 bg-white"
          />
        </div>
      </div>

      <Field label="Plain text body" hint="Left blank, a text version is derived from the HTML.">
        <textarea
          name="bodyText"
          defaultValue={bodyText}
          disabled={disabled}
          rows={5}
          className={`${inputClass} font-mono text-xs`}
        />
      </Field>

      <Button type="submit" variant="primary" disabled={disabled || pending}>
        {pending ? 'Saving…' : 'Save content'}
      </Button>
      <Feedback error={error} message={message} />
    </form>
  );
}

export function RecipientPicker({
  campaignId, lists, currentCount, disabled,
}: {
  campaignId: string;
  lists: Array<{ id: string; name: string; members: string }>;
  currentCount: number;
  disabled: boolean;
}) {
  const { run, error, message, pending } = useAction();
  const [selected, setSelected] = useState<string[]>([]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        {currentCount > 0
          ? `${currentCount} email(s) have been built for this campaign.`
          : 'No emails have been built yet. Choose lists, then save.'}
      </p>

      {lists.length === 0 ? (
        <p className="text-sm text-slate-500">
          No contact lists yet. Import contacts first.
        </p>
      ) : (
        <div className="space-y-2">
          {lists.map((l) => (
            <label key={l.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={disabled}
                checked={selected.includes(l.id)}
                onChange={(e) =>
                  setSelected((prev) =>
                    e.target.checked ? [...prev, l.id] : prev.filter((x) => x !== l.id),
                  )
                }
              />
              <span className="font-medium">{l.name}</span>
              <span className="text-xs text-slate-500">{l.members} contacts</span>
            </label>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          disabled={disabled || pending || selected.length === 0}
          onClick={() =>
            run(
              () => setRecipients({ campaignId, listIds: selected, contactIds: [], replace: true }),
              'Audience saved.',
            )
          }
        >
          {pending ? 'Saving…' : 'Set audience'}
        </Button>
        <Button
          disabled={disabled || pending}
          onClick={() =>
            run(async () => {
              const result = await materializeCampaign({ campaignId });
              return result.ok
                ? { ok: true }
                : { ok: false, error: result.error ?? '' };
            }, 'Emails built. Suppressed recipients are marked, not silently dropped.')
          }
        >
          Build emails
        </Button>
      </div>
      <Feedback error={error} message={message} />
    </div>
  );
}

const DAYS = [
  [1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun'],
] as const;

export function ScheduleEditor({
  campaignId, schedule, disabled,
}: {
  campaignId: string;
  schedule: Record<string, unknown> | null;
  disabled: boolean;
}) {
  const { run, error, message, pending } = useAction();
  const current = (schedule?.allowed_days as number[] | undefined) ?? [1, 2, 3, 4, 5];
  const [days, setDays] = useState<number[]>(current.map(Number));

  return (
    <form
      action={(formData) =>
        run(
          () =>
            setSchedule({
              campaignId,
              timezone: formData.get('timezone'),
              allowedDays: days,
              windowStart: formData.get('windowStart'),
              windowEnd: formData.get('windowEnd'),
              emailsPerHour: formData.get('emailsPerHour'),
              emailsPerDay: formData.get('emailsPerDay'),
              minGapSeconds: formData.get('minGapSeconds'),
            }),
          'Schedule saved.',
        )
      }
      className="space-y-4"
    >
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Timezone" hint="Days and hours are interpreted here.">
          <input
            name="timezone"
            defaultValue={String(schedule?.timezone ?? 'America/Toronto')}
            disabled={disabled}
            className={inputClass}
          />
        </Field>
        <Field label="Send between (from)">
          <input
            name="windowStart" type="time" disabled={disabled}
            defaultValue={String(schedule?.window_start ?? '09:00').slice(0, 5)}
            className={inputClass}
          />
        </Field>
        <Field label="Send between (to)">
          <input
            name="windowEnd" type="time" disabled={disabled}
            defaultValue={String(schedule?.window_end ?? '17:00').slice(0, 5)}
            className={inputClass}
          />
        </Field>
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium text-slate-700">Allowed days</span>
        <div className="flex flex-wrap gap-2">
          {DAYS.map(([n, label]) => (
            <label key={n} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                disabled={disabled}
                checked={days.includes(n)}
                onChange={(e) =>
                  setDays((prev) =>
                    e.target.checked ? [...prev, n].sort() : prev.filter((d) => d !== n),
                  )
                }
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Emails per hour">
          <input
            name="emailsPerHour" type="number" min={1} disabled={disabled}
            defaultValue={String(schedule?.emails_per_hour ?? 30)} className={inputClass}
          />
        </Field>
        <Field label="Emails per day">
          <input
            name="emailsPerDay" type="number" min={1} disabled={disabled}
            defaultValue={String(schedule?.emails_per_day ?? 200)} className={inputClass}
          />
        </Field>
        <Field label="Minimum gap (seconds)" hint="4s keeps you well under Exchange throttling.">
          <input
            name="minGapSeconds" type="number" min={0} disabled={disabled}
            defaultValue={String(schedule?.min_gap_seconds ?? 4)} className={inputClass}
          />
        </Field>
      </div>

      <Button type="submit" variant="primary" disabled={disabled || pending}>
        {pending ? 'Saving…' : 'Save schedule'}
      </Button>
      <Feedback error={error} message={message} />
    </form>
  );
}

const PROBLEM_TEXT: Record<string, string> = {
  missing_unsubscribe: 'The body has no unsubscribe link. Add {{unsubscribe_url}}.',
  missing_postal_address: 'The body has no postal address. Add {{postal_address}}.',
  missing_schedule: 'No schedule has been set.',
  no_recipients: 'No recipients have been chosen.',
  no_content_version: 'No content has been written.',
};

export function ApprovalPanel({
  campaignId, problems, canApprove, status,
}: {
  campaignId: string;
  problems: string[];
  canApprove: boolean;
  status: string;
}) {
  const { run, error, message, pending } = useAction();
  const [confirmation, setConfirmation] = useState('');
  const ready = problems.length === 0;

  return (
    <Card title="Review and approve" tone={ready ? 'default' : 'warn'}>
      <ul className="space-y-1 text-sm">
        {['missing_unsubscribe', 'missing_postal_address', 'missing_schedule', 'no_recipients'].map((key) => {
          const failing = problems.includes(key);
          return (
            <li key={key} className={failing ? 'text-amber-800' : 'text-green-700'}>
              {failing ? '✗' : '✓'} {PROBLEM_TEXT[key]?.replace(/^The body has no /, 'Unsubscribe link / ') ?? key}
              {failing && <span className="ml-1 text-xs">— {PROBLEM_TEXT[key]}</span>}
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-xs text-slate-500">
        Approving locks the campaign to this exact content. If you edit it afterwards, the approval
        is revoked and every unsent email is cancelled.
      </p>

      {!canApprove ? (
        <p className="mt-3 text-sm text-slate-500">
          Approving requires the approver or owner role.
        </p>
      ) : (
        <div className="mt-3 flex items-end gap-2">
          <Field label="Type APPROVE to confirm">
            <input
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              disabled={!ready}
              className={inputClass}
            />
          </Field>
          <Button
            variant="primary"
            disabled={!ready || pending || confirmation !== 'APPROVE' || status === 'approved'}
            onClick={() =>
              run(
                () => approveCampaign({ campaignId, confirmation: 'APPROVE' }),
                'Approved. Emails have been built and the campaign is ready to start.',
              )
            }
          >
            {pending ? 'Approving…' : 'Approve campaign'}
          </Button>
        </div>
      )}
      <Feedback error={error} message={message} />
    </Card>
  );
}

export function CampaignControls({
  campaignId, status, name, canControl,
}: {
  campaignId: string;
  status: string;
  name: string;
  canControl: boolean;
}) {
  const { run, error, pending } = useAction();
  const [stopping, setStopping] = useState(false);
  const [confirmation, setConfirmation] = useState('');

  if (!canControl) return null;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        {['approved', 'scheduled', 'paused'].includes(status) && (
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              run(() => (status === 'paused' ? resumeCampaign({ campaignId }) : startCampaign({ campaignId })))
            }
          >
            {status === 'paused' ? 'Resume' : 'Start sending'}
          </Button>
        )}
        {status === 'running' && (
          <Button disabled={pending} onClick={() => run(() => pauseCampaign({ campaignId, reason: 'Paused from the console' }))}>
            Pause
          </Button>
        )}
        {!['stopped', 'completed', 'archived', 'draft'].includes(status) && (
          <Button variant="danger" disabled={pending} onClick={() => setStopping((s) => !s)}>
            Stop
          </Button>
        )}
      </div>

      {stopping && (
        <div className="w-80 rounded border border-red-300 bg-white p-3 shadow">
          <p className="text-xs text-slate-600">
            Stopping cancels every email that has not been sent. This cannot be undone.
          </p>
          <input
            className={`${inputClass} mt-2`}
            placeholder="Type STOP to confirm"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <Button
              variant="danger"
              disabled={pending || confirmation !== 'STOP'}
              onClick={() =>
                run(() => stopCampaign({ campaignId, confirmation: 'STOP', reason: `Stopped from the console: ${name}` }))
              }
            >
              Stop campaign
            </Button>
            <Button onClick={() => setStopping(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}

export function JobActions({ jobId }: { jobId: string }) {
  const { run, pending } = useAction();
  return (
    <button
      disabled={pending}
      onClick={() => run(() => requeueJob({ jobId, reason: 'Requeued from the console' }))}
      className="ml-2 text-xs text-blue-700 hover:underline disabled:opacity-50"
    >
      retry
    </button>
  );
}
