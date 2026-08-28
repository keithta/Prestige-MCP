'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { commitImport, previewImport } from '@/lib/actions/contacts';
import type { ImportPreview } from '@/lib/actions/types';
import { Button, Field, Table, inputClass } from '@/components/ui';

/**
 * Import in two steps: analyse, then commit.
 *
 * The dry run is not a nicety. An operator uploading the wrong file is one of
 * the likeliest ways to email the wrong people, and seeing the counts before
 * anything is written is what stops it.
 */
export function ImportWizard() {
  const router = useRouter();
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('');
  const [listName, setListName] = useState('');
  const [consentNote, setConsentNote] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [committed, setCommitted] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  async function readFile(file: File) {
    if (file.size > 20 * 1024 * 1024) {
      setError('That file is larger than 20 MB.');
      return;
    }
    const text = await file.text();
    setCsv(text);
    setFilename(file.name);
    setPreview(null);
    setCommitted(null);
    setError(null);
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="CSV file" hint="A header row with an email column.">
          <input
            type="file"
            accept=".csv,text/csv"
            className="w-full text-sm"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
        </Field>
        <Field label="Add to list" hint="Optional. Creates the list if it does not exist.">
          <input
            name="listName"
            value={listName}
            onChange={(e) => setListName(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Consent note" hint="Where this list came from. Recorded per contact.">
          <input
            name="consentNote"
            value={consentNote}
            onChange={(e) => setConsentNote(e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="flex gap-2">
        <Button
          disabled={!csv || pending}
          onClick={() => {
            setError(null);
            start(async () => {
              const result = await previewImport({ csv, mapping: {} });
              if (!result.ok) setError(result.error ?? 'Failed.');
              else setPreview(result.data!);
            });
          }}
        >
          {pending ? 'Analysing…' : 'Analyse file'}
        </Button>
        <Button
          variant="primary"
          disabled={!preview || pending || preview.valid === 0}
          onClick={() => {
            setError(null);
            start(async () => {
              const result = await commitImport({
                csv, filename, mapping: {},
                listName: listName || undefined,
                consentNote: consentNote || undefined,
              });
              if (!result.ok) setError(result.error ?? 'Failed.');
              else {
                setCommitted(result.data!);
                setPreview(null);
                router.refresh();
              }
            });
          }}
        >
          Import {preview ? `${preview.valid} contacts` : ''}
        </Button>
      </div>

      {error && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
      )}

      {preview && (
        <div className="rounded border border-blue-200 bg-blue-50 p-4">
          <h3 className="text-sm font-semibold text-blue-900">
            Dry run — nothing has been written yet
          </h3>
          <div className="mt-2 grid grid-cols-2 gap-2 text-sm md:grid-cols-5">
            <Count label="Rows" value={preview.totalRows} />
            <Count label="Will import" value={preview.valid} tone="ok" />
            <Count label="Already present" value={preview.alreadyPresent} />
            <Count label="Duplicates in file" value={preview.duplicatesInFile} />
            <Count label="Invalid" value={preview.invalid} tone={preview.invalid ? 'danger' : 'default'} />
          </div>
          {preview.suppressed > 0 && (
            <p className="mt-2 text-sm text-purple-800">
              {preview.suppressed} address(es) are on the suppression list. They will be imported and
              flagged, but no campaign will contact them.
            </p>
          )}
          {preview.errors.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-slate-700">Rejected rows (first 100)</p>
              <div className="mt-1 max-h-40 overflow-y-auto">
                <Table head={['Row', 'Value', 'Reason']}>
                  {preview.errors.map((e, i) => (
                    <tr key={i}>
                      <td className="px-3 py-1 tabular-nums">{e.row}</td>
                      <td className="px-3 py-1 font-mono text-xs">{e.value || '(blank)'}</td>
                      <td className="px-3 py-1 text-xs">{e.reason}</td>
                    </tr>
                  ))}
                </Table>
              </div>
            </div>
          )}
        </div>
      )}

      {committed && (
        <div className="rounded border border-green-200 bg-green-50 p-4 text-sm text-green-900">
          Imported {committed.valid} new contact(s); {committed.alreadyPresent} already existed;{' '}
          {committed.invalid} row(s) were rejected.
        </div>
      )}
    </div>
  );
}

function Count({
  label, value, tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'ok' | 'danger';
}) {
  const color = tone === 'ok' ? 'text-green-700' : tone === 'danger' ? 'text-red-700' : 'text-slate-900';
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
