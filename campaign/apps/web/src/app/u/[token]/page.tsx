import { asService } from '@/lib/db';

/**
 * One-click unsubscribe.
 *
 * The URL carries only an opaque per-job token, never the address, so a link
 * cannot be used to enumerate contacts or to unsubscribe somebody else. An
 * invalid token renders exactly the same page as a valid one, so it reveals
 * nothing about whether it was ever real.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function UnsubscribePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  let campaignName: string | null = null;
  if (UUID.test(token)) {
    try {
      campaignName = await asService(async (client) => {
        const { rows } = await client.query<{ ok: boolean; campaign_name: string | null }>(
          'SELECT ok, campaign_name FROM campaign.unsubscribe_by_token($1)',
          [token],
        );
        return rows[0]?.campaign_name ?? null;
      });
    } catch {
      campaignName = null;
    }
  }

  return (
    <div className="mx-auto mt-24 max-w-md rounded-lg border border-slate-200 bg-white p-8 text-center">
      <h1 className="text-lg font-semibold text-slate-900">You have been unsubscribed</h1>
      <p className="mt-3 text-sm text-slate-600">
        {campaignName
          ? `You will not receive further emails from this sender, including "${campaignName}".`
          : 'You will not receive further emails from this sender.'}
      </p>
      <p className="mt-4 text-xs text-slate-400">
        This takes effect immediately, including for messages already scheduled.
      </p>
    </div>
  );
}
