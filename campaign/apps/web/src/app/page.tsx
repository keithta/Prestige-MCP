import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { listCampaigns, openAlerts, queueHealth, senderCapacity, contactCount } from '@/lib/queries';
import { Badge, Card, Empty, Stat, Table, relativeTime } from '@/components/ui';
import { AlertActions, EmergencyStopControl } from './controls';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const session = await getSession();
  if (!session) redirect('/login');

  const [health, campaigns, alerts, senders, contacts] = await Promise.all([
    queueHealth(session),
    listCampaigns(session),
    openAlerts(session),
    senderCapacity(session),
    contactCount(session),
  ]);

  const active = campaigns.filter((c) => ['running', 'paused'].includes(c.status));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Dashboard</h1>
        <EmergencyStopControl engaged={Boolean(health.emergency_stop)} />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Sent (24h)" value={String(health.sent_last_24h ?? 0)} tone="ok"
              hint={`${health.sent_last_hour ?? 0} in the last hour`} />
        <Stat label="Ready to send" value={String(health.ready_now ?? 0)}
              hint={`${health.queued ?? 0} queued in total`} />
        <Stat label="In flight" value={String(health.in_flight ?? 0)} />
        <Stat
          label="Needs attention"
          value={String(health.needs_reconciliation ?? 0)}
          tone={Number(health.needs_reconciliation ?? 0) > 0 ? 'danger' : 'default'}
          hint="Sends whose outcome is unknown"
        />
        <Stat label="Contacts" value={contacts.total}
              hint={`${contacts.suppressed} suppressed`} />
      </div>

      {alerts.length > 0 && (
        <Card title={`Open alerts (${alerts.length})`} tone="danger">
          <div className="space-y-2">
            {alerts.map((a) => (
              <div
                key={String(a.id)}
                className="flex items-start justify-between gap-4 rounded border border-slate-200 p-3"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <Badge value={String(a.severity)} />
                    <span className="text-sm font-medium">{String(a.title)}</span>
                    <span className="text-xs text-slate-500">{relativeTime(String(a.created_at))}</span>
                  </div>
                  {a.detail ? <p className="mt-1 text-sm text-slate-600">{String(a.detail)}</p> : null}
                </div>
                <AlertActions id={Number(a.id)} acknowledged={Boolean(a.acknowledged_at)} />
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="Active campaigns" actions={<Link href="/campaigns" className="text-sm text-blue-700 underline">All campaigns</Link>}>
        {active.length === 0 ? (
          <Empty>No campaigns are running.</Empty>
        ) : (
          <Table head={['Campaign', 'Status', 'Progress', 'Window', 'Last sent']}>
            {active.map((c) => {
              const total = Number(c.total_jobs);
              const sent = Number(c.sent);
              const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
              return (
                <tr key={c.campaign_id}>
                  <td className="px-3 py-2">
                    <Link href={`/campaigns/${c.campaign_id}`} className="font-medium text-blue-700 hover:underline">
                      {c.name}
                    </Link>
                    <div className="text-xs text-slate-500">{c.sender_mailbox} · {c.send_mode}</div>
                  </td>
                  <td className="px-3 py-2"><Badge value={c.status} /></td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-28 overflow-hidden rounded bg-slate-200">
                        <div className="h-full bg-blue-600" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs tabular-nums text-slate-600">
                        {sent}/{total}
                      </span>
                    </div>
                    {Number(c.failed) > 0 && (
                      <span className="text-xs text-red-700">{c.failed} failed</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {c.in_window ? (
                      <span className="text-green-700">open</span>
                    ) : (
                      <span className="text-amber-700">
                        closed · opens {relativeTime(c.next_window_open)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">{relativeTime(c.last_sent_at)}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card title="Sending capacity today">
        {senders.length === 0 ? (
          <Empty>No sending mailboxes are configured. Add one in Settings.</Empty>
        ) : (
          <Table head={['Mailbox', 'Status', 'This hour', 'Today', 'Remaining today']}>
            {senders.map((s) => (
              <tr key={String(s.sender_account_id)}>
                <td className="px-3 py-2 font-medium">{String(s.mailbox_address)}</td>
                <td className="px-3 py-2"><Badge value={String(s.status)} /></td>
                <td className="px-3 py-2 tabular-nums">
                  {String(s.sent_this_hour)} / {String(s.hourly_limit)}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {String(s.sent_today)} / {String(s.daily_limit)}
                </td>
                <td className="px-3 py-2 tabular-nums">{String(s.daily_remaining)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
