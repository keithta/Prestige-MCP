import { redirect } from 'next/navigation';
import { getSession, hasRole } from '@/lib/auth';
import { listSuppressions } from '@/lib/queries';
import { Badge, Card, Empty, Table, relativeTime } from '@/components/ui';
import { AddSuppressionForm, RevokeButton } from './forms';

export const dynamic = 'force-dynamic';

export default async function SuppressionsPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const rows = await listSuppressions(session);
  const active = rows.filter((r) => !r.revoked_at);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Suppressions</h1>

      <div className="rounded border border-slate-200 bg-white p-4 text-sm text-slate-600">
        Addresses here are never contacted by any campaign. The list is append-only: an unsubscribe
        or a spam complaint can never be removed, because honouring it is a legal obligation rather
        than an operational preference.
      </div>

      {hasRole(session, 'operator') && (
        <Card title="Add a suppression">
          <AddSuppressionForm />
        </Card>
      )}

      <Card title={`Suppressed (${active.length} active)`}>
        {rows.length === 0 ? (
          <Empty>Nothing is suppressed.</Empty>
        ) : (
          <Table head={['Address / domain', 'Reason', 'Source', 'Added', 'State', '']}>
            {rows.map((r) => (
              <tr key={String(r.id)} className={r.revoked_at ? 'opacity-50' : ''}>
                <td className="px-3 py-2 font-medium">
                  {String(r.email ?? r.domain ?? '')}
                  {r.domain ? <span className="ml-2 text-xs text-slate-500">(whole domain)</span> : null}
                </td>
                <td className="px-3 py-2"><Badge value={String(r.reason)} /></td>
                <td className="px-3 py-2 text-xs text-slate-500">{String(r.source ?? '—')}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{relativeTime(String(r.created_at))}</td>
                <td className="px-3 py-2 text-xs">
                  {r.revoked_at ? `revoked — ${String(r.revoke_reason ?? '')}` : 'active'}
                </td>
                <td className="px-3 py-2 text-right">
                  {!r.revoked_at &&
                    hasRole(session, 'owner') &&
                    !['unsubscribe', 'complaint'].includes(String(r.reason)) && (
                      <RevokeButton id={String(r.id)} />
                    )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
