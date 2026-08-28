import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession, hasRole } from '@/lib/auth';
import { listCampaigns, listSenders } from '@/lib/queries';
import { Badge, Card, Empty, Table, relativeTime } from '@/components/ui';
import { NewCampaignForm } from './new-campaign';

export const dynamic = 'force-dynamic';

export default async function CampaignsPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const [campaigns, senders] = await Promise.all([listCampaigns(session), listSenders(session)]);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Campaigns</h1>

      {hasRole(session, 'operator') && (
        <Card title="New campaign">
          {senders.length === 0 ? (
            <Empty>
              Add a sending mailbox in <Link href="/settings" className="text-blue-700 underline">Settings</Link> first.
            </Empty>
          ) : (
            <NewCampaignForm
              senders={senders.map((s) => ({
                id: String(s.id),
                mailbox: String(s.mailbox_address),
              }))}
            />
          )}
        </Card>
      )}

      <Card title={`All campaigns (${campaigns.length})`}>
        {campaigns.length === 0 ? (
          <Empty>No campaigns yet.</Empty>
        ) : (
          <Table head={['Campaign', 'Status', 'Mode', 'Sent', 'Failed', 'Remaining', 'Last sent']}>
            {campaigns.map((c) => (
              <tr key={c.campaign_id}>
                <td className="px-3 py-2">
                  <Link href={`/campaigns/${c.campaign_id}`} className="font-medium text-blue-700 hover:underline">
                    {c.name}
                  </Link>
                  <div className="text-xs text-slate-500">{c.sender_mailbox}</div>
                </td>
                <td className="px-3 py-2"><Badge value={c.status} /></td>
                <td className="px-3 py-2">
                  <Badge value={c.send_mode === 'production' ? 'running' : 'pending'} />
                  <span className="ml-1 text-xs text-slate-600">{c.send_mode}</span>
                </td>
                <td className="px-3 py-2 tabular-nums">{c.sent}</td>
                <td className="px-3 py-2 tabular-nums">
                  {Number(c.failed) > 0 ? <span className="text-red-700">{c.failed}</span> : '0'}
                </td>
                <td className="px-3 py-2 tabular-nums">{c.remaining}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{relativeTime(c.last_sent_at)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
