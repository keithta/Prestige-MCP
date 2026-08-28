import { redirect } from 'next/navigation';
import { getSession, hasRole } from '@/lib/auth';
import { contactCount, listContactLists, listContacts } from '@/lib/queries';
import { Badge, Card, Empty, Stat, Table, relativeTime } from '@/components/ui';
import { ImportWizard } from './import-wizard';

export const dynamic = 'force-dynamic';

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const { q } = await searchParams;
  const [contacts, counts, lists] = await Promise.all([
    listContacts(session, q),
    contactCount(session),
    listContactLists(session),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Contacts</h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Stat label="Contacts" value={counts.total} />
        <Stat label="Suppressed addresses" value={counts.suppressed} />
        <Stat label="Lists" value={String(lists.length)} />
      </div>

      {hasRole(session, 'operator') && (
        <Card title="Import contacts">
          <ImportWizard />
        </Card>
      )}

      <Card title="Lists">
        {lists.length === 0 ? (
          <Empty>No lists yet. Give a list a name when you import.</Empty>
        ) : (
          <Table head={['List', 'Contacts', 'Description']}>
            {lists.map((l) => (
              <tr key={String(l.id)}>
                <td className="px-3 py-2 font-medium">{String(l.name)}</td>
                <td className="px-3 py-2 tabular-nums">{String(l.members)}</td>
                <td className="px-3 py-2 text-sm text-slate-600">{String(l.description ?? '')}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card
        title="All contacts"
        actions={
          <form className="flex gap-2">
            <input
              name="q"
              defaultValue={q ?? ''}
              placeholder="Search name, email, company"
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </form>
        }
      >
        {contacts.length === 0 ? (
          <Empty>{q ? 'No contacts match that search.' : 'No contacts yet. Import a CSV above.'}</Empty>
        ) : (
          <Table head={['Email', 'Name', 'Company', 'Status', 'Source', 'Added']}>
            {contacts.map((c) => (
              <tr key={String(c.id)}>
                <td className="px-3 py-2">
                  {String(c.email)}
                  {c.suppressed ? <span className="ml-2"><Badge value="suppressed" /></span> : null}
                </td>
                <td className="px-3 py-2">
                  {[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}
                </td>
                <td className="px-3 py-2">{String(c.company ?? '—')}</td>
                <td className="px-3 py-2"><Badge value={String(c.status)} /></td>
                <td className="px-3 py-2 text-xs text-slate-500">{String(c.source ?? '—')}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{relativeTime(String(c.created_at))}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
