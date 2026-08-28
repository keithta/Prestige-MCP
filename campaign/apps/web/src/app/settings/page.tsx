import { redirect } from 'next/navigation';
import { getSession, hasRole } from '@/lib/auth';
import { complianceSettings, listSenders, listTestRecipients, queueHealth } from '@/lib/queries';
import { Badge, Card, Empty, Table } from '@/components/ui';
import {
  ComplianceForm, NewOperatorForm, NewSenderForm, ProductionModeControl,
  SenderStatusControl, TestRecipientForm, GlobalSendControl,
} from './forms';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const isOwner = hasRole(session, 'owner');
  const [senders, testRecipients, compliance, health] = await Promise.all([
    listSenders(session),
    listTestRecipients(session),
    complianceSettings(session),
    queueHealth(session),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Settings</h1>

      <Card title="Sending mode" tone={health.production_mode ? 'danger' : 'default'}>
        <div className="space-y-3 text-sm">
          <p>
            Reaching a real recipient requires <strong>both</strong> switches: the campaign must be
            in production mode, and production sending must be enabled here. Until then, only
            addresses on the test allowlist below can be contacted, at any volume.
          </p>
          <div className="flex flex-wrap items-center gap-6">
            <div>
              <div className="text-xs text-slate-500">Production sending</div>
              <Badge value={health.production_mode ? 'running' : 'pending'} />
            </div>
            <div>
              <div className="text-xs text-slate-500">Global sending</div>
              <Badge value={health.global_send_enabled ? 'active' : 'disabled'} />
            </div>
            <div>
              <div className="text-xs text-slate-500">Emergency stop</div>
              <Badge value={health.emergency_stop ? 'stopped' : 'active'} />
            </div>
          </div>
          {isOwner && (
            <div className="flex flex-wrap gap-3 pt-2">
              <ProductionModeControl enabled={Boolean(health.production_mode)} />
              <GlobalSendControl enabled={Boolean(health.global_send_enabled)} />
            </div>
          )}
        </div>
      </Card>

      <Card title="Test recipients">
        <p className="mb-3 text-sm text-slate-600">
          While a campaign is in test mode, these are the only addresses it can reach.
        </p>
        {testRecipients.length === 0 ? (
          <Empty>No test recipients. A test campaign will send nothing.</Empty>
        ) : (
          <ul className="mb-4 space-y-1 text-sm">
            {testRecipients.map((t) => (
              <li key={String(t.id)} className="font-mono text-xs">{String(t.email)}</li>
            ))}
          </ul>
        )}
        {isOwner && <TestRecipientForm />}
      </Card>

      <Card title="Sending mailboxes">
        {senders.length === 0 ? (
          <Empty>No mailboxes configured. Add the mailbox your Entra app is allowed to send as.</Empty>
        ) : (
          <Table head={['Mailbox', 'Status', 'Hourly', 'Daily', 'Gap', 'Timezone', '']}>
            {senders.map((s) => (
              <tr key={String(s.id)}>
                <td className="px-3 py-2">
                  <div className="font-medium">{String(s.mailbox_address)}</div>
                  {s.paused_reason ? (
                    <div className="text-xs text-red-700">{String(s.paused_reason)}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2"><Badge value={String(s.status)} /></td>
                <td className="px-3 py-2 tabular-nums text-xs">
                  {String(s.sent_this_hour)}/{String(s.hourly_limit)}
                </td>
                <td className="px-3 py-2 tabular-nums text-xs">
                  {String(s.sent_today)}/{String(s.daily_limit)}
                </td>
                <td className="px-3 py-2 tabular-nums text-xs">{String(s.min_interval_seconds)}s</td>
                <td className="px-3 py-2 text-xs">{String(s.timezone)}</td>
                <td className="px-3 py-2 text-right">
                  {isOwner && (
                    <SenderStatusControl id={String(s.id)} status={String(s.status)} />
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
        {isOwner && (
          <div className="mt-4 border-t border-slate-200 pt-4">
            <NewSenderForm />
          </div>
        )}
      </Card>

      <Card title="Compliance details" tone={compliance.postal_address ? 'default' : 'warn'}>
        <p className="mb-3 text-sm text-slate-600">
          These fill {'{{postal_address}}'} and build the unsubscribe link in every campaign. A
          campaign cannot be approved without them.
        </p>
        {isOwner ? (
          <ComplianceForm settings={compliance} />
        ) : (
          <dl className="space-y-1 text-sm">
            <div><dt className="inline text-slate-500">Organisation: </dt><dd className="inline">{String(compliance.org_name ?? '—')}</dd></div>
            <div><dt className="inline text-slate-500">Postal address: </dt><dd className="inline">{String(compliance.postal_address ?? '—')}</dd></div>
            <div><dt className="inline text-slate-500">Application URL: </dt><dd className="inline">{String(compliance.app_base_url ?? '—')}</dd></div>
          </dl>
        )}
      </Card>

      {isOwner && (
        <Card title="Operators">
          <NewOperatorForm />
        </Card>
      )}
    </div>
  );
}
