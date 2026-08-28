import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { listAudit } from '@/lib/queries';
import { Card, Empty, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

const QUICK_FILTERS = [
  ['', 'Everything'],
  ['campaign.', 'Campaigns'],
  ['system.', 'System controls'],
  ['suppression.', 'Suppressions'],
  ['send.', 'Sending'],
  ['email_job.', 'Job transitions'],
  ['operator.', 'Operators'],
] as const;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const { action } = await searchParams;
  const events = await listAudit(session, { action: action || undefined, limit: 300 });

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Audit trail</h1>
      <p className="text-sm text-slate-600">
        Append-only. Every state change, control action, and refused send is recorded here and
        cannot be modified or deleted by anyone, including the database service role.
      </p>

      <div className="flex flex-wrap gap-1">
        {QUICK_FILTERS.map(([value, label]) => (
          <a
            key={label}
            href={value ? `/audit?action=${value}` : '/audit'}
            className={`rounded px-2 py-1 text-xs ${
              (action ?? '') === value ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {label}
          </a>
        ))}
      </div>

      <Card title={`${events.length} event(s)`}>
        {events.length === 0 ? (
          <Empty>Nothing recorded yet.</Empty>
        ) : (
          <Table head={['When', 'Actor', 'Action', 'Entity', 'Reason', 'Detail']}>
            {events.map((e) => (
              <tr key={String(e.id)}>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
                  {new Date(String(e.occurred_at)).toISOString().replace('T', ' ').slice(0, 19)}
                </td>
                <td className="px-3 py-2 text-xs">
                  {String(e.actor_label ?? e.actor_type)}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{String(e.action)}</td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {e.entity_type ? `${e.entity_type} ${String(e.entity_id ?? '').slice(0, 8)}` : '—'}
                </td>
                <td className="px-3 py-2 text-xs">{String(e.reason_code ?? '—')}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">
                  {summarize(e)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function summarize(event: Record<string, unknown>): string {
  const before = event.before_state as Record<string, unknown> | null;
  const after = event.after_state as Record<string, unknown> | null;
  if (before?.status && after?.status) return `${before.status} → ${after.status}`;
  const meta = event.metadata as Record<string, unknown> | null;
  if (meta && Object.keys(meta).length > 0) {
    return JSON.stringify(meta).slice(0, 120);
  }
  if (after) return JSON.stringify(after).slice(0, 120);
  return '—';
}
