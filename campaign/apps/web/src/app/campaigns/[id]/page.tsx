import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSession, hasRole } from '@/lib/auth';
import {
  getCampaign, jobAttempts, listContactLists, listJobs,
} from '@/lib/queries';
import { explainDenial } from '@campaign/core';
import { Badge, Card, Empty, Stat, Table, relativeTime } from '@/components/ui';
import { CampaignControls, ContentEditor, RecipientPicker, ScheduleEditor, ApprovalPanel, JobActions } from './editors';

export const dynamic = 'force-dynamic';

const FILTERS = [
  ['all', 'All'], ['sent', 'Sent'], ['failed', 'Failed'], ['retrying', 'Retrying'],
  ['pending', 'Pending'], ['suppressed', 'Suppressed'], ['skipped', 'Skipped/cancelled'],
  ['attention', 'Needs attention'],
] as const;

export default async function CampaignDetail({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ filter?: string; job?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const { id } = await params;
  const { filter = 'all', job } = await searchParams;

  const { progress, campaign, schedule, content, complianceProblems } = await getCampaign(session, id);
  if (!campaign || !progress) notFound();

  const [jobs, lists, attempts] = await Promise.all([
    listJobs(session, id, filter),
    listContactLists(session),
    job ? jobAttempts(session, job) : Promise.resolve([]),
  ]);

  const canEdit = hasRole(session, 'operator') &&
    ['draft', 'pending_approval'].includes(String(campaign.status));
  const total = Number(progress.total_jobs);
  const sent = Number(progress.sent);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/campaigns" className="text-xs text-slate-500 hover:underline">← Campaigns</Link>
          <h1 className="text-lg font-semibold">{String(campaign.name)}</h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
            <Badge value={String(campaign.status)} />
            <span>{progress.sender_mailbox}</span>
            <span>·</span>
            <span className={campaign.send_mode === 'production' ? 'font-semibold text-red-700' : ''}>
              {String(campaign.send_mode)} mode
            </span>
          </div>
        </div>
        <CampaignControls
          campaignId={id}
          status={String(campaign.status)}
          name={String(campaign.name)}
          canControl={hasRole(session, 'operator')}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        <Stat label="Total" value={progress.total_jobs} />
        <Stat label="Sent" value={progress.sent} tone="ok" />
        <Stat label="Remaining" value={progress.remaining} />
        <Stat label="Retrying" value={progress.retrying} tone={Number(progress.retrying) > 0 ? 'warn' : 'default'} />
        <Stat label="Failed" value={progress.failed} tone={Number(progress.failed) > 0 ? 'danger' : 'default'} />
        <Stat label="Suppressed" value={progress.suppressed} />
      </div>

      {Number(progress.needs_reconciliation) > 0 && (
        <Card title="Sends with an unknown outcome" tone="danger">
          <p className="text-sm text-slate-700">
            {progress.needs_reconciliation} email(s) were handed to Microsoft Graph but the result never
            came back. They will <strong>not</strong> be retried automatically. The worker checks Sent
            Items each cycle and resolves them from evidence.
          </p>
        </Card>
      )}

      {total > 0 && (
        <Card title="Progress">
          <div className="flex items-center gap-3">
            <div className="h-3 flex-1 overflow-hidden rounded bg-slate-200">
              <div className="h-full bg-blue-600" style={{ width: `${total ? (sent / total) * 100 : 0}%` }} />
            </div>
            <span className="text-sm tabular-nums text-slate-600">
              {sent} / {total}
            </span>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {progress.in_window
              ? 'Inside the sending window now.'
              : `Outside the sending window. Opens ${relativeTime(progress.next_window_open)}.`}
          </p>
        </Card>
      )}

      {['draft', 'pending_approval'].includes(String(campaign.status)) && (
        <>
          <Card title="Email content">
            <ContentEditor
              campaignId={id}
              disabled={!canEdit}
              subject={String(content?.subject_template ?? '')}
              bodyHtml={String(content?.body_html_template ?? '')}
              bodyText={String(content?.body_text_template ?? '')}
            />
          </Card>

          <Card title="Recipients">
            <RecipientPicker
              campaignId={id}
              disabled={!canEdit}
              lists={lists.map((l) => ({
                id: String(l.id), name: String(l.name), members: String(l.members),
              }))}
              currentCount={total}
            />
          </Card>

          <Card title="Schedule and cadence">
            <ScheduleEditor
              campaignId={id}
              disabled={!canEdit}
              schedule={schedule as Record<string, unknown> | null}
            />
          </Card>

          <ApprovalPanel
            campaignId={id}
            problems={complianceProblems}
            canApprove={hasRole(session, 'approver')}
            status={String(campaign.status)}
          />
        </>
      )}

      <Card
        title="Emails"
        actions={
          <div className="flex flex-wrap gap-1">
            {FILTERS.map(([value, label]) => (
              <Link
                key={value}
                href={`/campaigns/${id}?filter=${value}`}
                className={`rounded px-2 py-1 text-xs ${
                  filter === value ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
        }
      >
        {jobs.length === 0 ? (
          <Empty>No emails match this filter.</Empty>
        ) : (
          <Table head={['Recipient', 'State', 'Why', 'Attempts', 'Sent', '']}>
            {jobs.map((j) => (
              <tr key={j.id} className={job === j.id ? 'bg-blue-50' : ''}>
                <td className="px-3 py-2">
                  <div className="font-medium">{j.recipient_email}</div>
                  {j.recipient_name && <div className="text-xs text-slate-500">{j.recipient_name}</div>}
                </td>
                <td className="px-3 py-2"><Badge value={j.effective_state} /></td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {/* Always an answer to "why isn't this moving?" */}
                  {j.current_denial_reason
                    ? explainDenial(j.current_denial_reason)
                    : j.last_error_message
                      ? `${j.last_error_code ?? 'error'}: ${j.last_error_message.slice(0, 120)}`
                      : j.suppressed_reason
                        ? `Suppressed: ${j.suppressed_reason}`
                        : j.skip_reason
                          ? j.skip_reason.replace(/_/g, ' ')
                          : '—'}
                </td>
                <td className="px-3 py-2 text-xs tabular-nums">
                  {j.attempt_count}/{j.max_attempts}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">{relativeTime(j.sent_at)}</td>
                <td className="px-3 py-2 text-right">
                  <Link
                    href={`/campaigns/${id}?filter=${filter}&job=${j.id}`}
                    className="text-xs text-blue-700 hover:underline"
                  >
                    history
                  </Link>
                  {['failed_permanent', 'skipped'].includes(j.status) && hasRole(session, 'operator') && (
                    <JobActions jobId={j.id} />
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {job && attempts.length > 0 && (
        <Card title="Attempt history">
          <Table head={['#', 'Outcome', 'HTTP', 'Class', 'Error', 'Graph request id', 'Duration']}>
            {attempts.map((a) => (
              <tr key={String(a.attempt_no)}>
                <td className="px-3 py-2 tabular-nums">{String(a.attempt_no)}</td>
                <td className="px-3 py-2"><Badge value={String(a.outcome)} /></td>
                <td className="px-3 py-2 tabular-nums">{String(a.http_status ?? '—')}</td>
                <td className="px-3 py-2 text-xs">{String(a.failure_class ?? '—')}</td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {a.error_code ? `${a.error_code}: ${String(a.error_message ?? '').slice(0, 160)}` : '—'}
                </td>
                {/* Quote this verbatim in a Microsoft support case. */}
                <td className="px-3 py-2 font-mono text-xs">{String(a.graph_request_id ?? '—')}</td>
                <td className="px-3 py-2 tabular-nums text-xs">
                  {a.duration_ms ? `${a.duration_ms}ms` : '—'}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
