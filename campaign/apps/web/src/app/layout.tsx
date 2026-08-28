import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { getSession } from '@/lib/auth';
import { asService } from '@/lib/db';
import { signOutAction } from '@/lib/actions/system';

export const metadata: Metadata = {
  title: 'Campaign Console',
  description: 'Approve, schedule and monitor email campaigns sent through Microsoft Graph.',
};

export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/contacts', label: 'Contacts' },
  { href: '/suppressions', label: 'Suppressions' },
  { href: '/audit', label: 'Audit' },
  { href: '/settings', label: 'Settings' },
];

async function globalState() {
  try {
    return await asService(async (client) => {
      const { rows } = await client.query<{
        emergency_stop: boolean;
        global_send_enabled: boolean;
        production_mode: boolean;
        emergency_stop_reason: string | null;
      }>(
        `SELECT emergency_stop, global_send_enabled, production_mode, emergency_stop_reason
           FROM campaign.system_controls WHERE id`,
      );
      return rows[0] ?? null;
    });
  } catch {
    return null;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const controls = await globalState();

  return (
    <html lang="en">
      <body className="min-h-screen">
        {/* The emergency stop is the first thing on the page, always. */}
        {controls?.emergency_stop && (
          <div className="stop-banner px-4 py-2 text-center text-sm">
            EMERGENCY STOP ENGAGED — nothing will send.
            {controls.emergency_stop_reason ? ` Reason: ${controls.emergency_stop_reason}` : ''}
          </div>
        )}
        {controls && !controls.emergency_stop && !controls.global_send_enabled && (
          <div className="bg-amber-600 px-4 py-2 text-center text-sm font-semibold text-white">
            Global sending is switched off. Campaigns will not send.
          </div>
        )}

        {session && (
          <header className="border-b border-slate-200 bg-white">
            <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
              <span className="font-semibold text-slate-900">Campaign Console</span>
              <nav className="flex flex-1 gap-1">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="rounded px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
              <span
                className={`rounded border px-2 py-0.5 text-xs font-medium ${
                  controls?.production_mode
                    ? 'border-red-200 bg-red-50 text-red-800'
                    : 'border-slate-200 bg-slate-50 text-slate-600'
                }`}
                title={
                  controls?.production_mode
                    ? 'Production sending is enabled. Campaigns in production mode can reach real recipients.'
                    : 'Production mode is off. Only addresses on the test allowlist can be reached.'
                }
              >
                {controls?.production_mode ? 'PRODUCTION' : 'TEST MODE'}
              </span>
              <span className="text-xs text-slate-500">
                {session.email} · {session.role}
              </span>
              <form action={signOutAction}>
                <button className="text-xs text-slate-500 underline hover:text-slate-800">
                  Sign out
                </button>
              </form>
            </div>
          </header>
        )}

        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
