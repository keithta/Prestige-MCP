import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { asService } from '@/lib/db';
import { LoginForm } from './form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await getSession()) redirect('/');

  // If nobody has been created yet, say so plainly rather than letting the
  // operator guess at credentials that do not exist.
  const hasOperators = await asService(async (client) => {
    const { rows } = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM campaign.app_profiles',
    );
    return Number(rows[0]!.n) > 0;
  }).catch(() => true);

  return (
    <div className="mx-auto mt-16 max-w-sm">
      <h1 className="mb-1 text-xl font-semibold">Campaign Console</h1>
      <p className="mb-6 text-sm text-slate-500">Sign in to manage campaigns.</p>
      {hasOperators ? (
        <LoginForm />
      ) : (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">No operator account exists yet.</p>
          <p className="mt-2">
            Create the first one from the project root:
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-white p-2 text-xs">
npm run create-owner -- you@example.com
          </pre>
        </div>
      )}
    </div>
  );
}
