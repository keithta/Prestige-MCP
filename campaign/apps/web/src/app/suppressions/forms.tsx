'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addSuppression, revokeSuppression } from '@/lib/actions/contacts';
import { Button, Field, inputClass } from '@/components/ui';

const REASONS = [
  'manual', 'unsubscribe', 'complaint', 'bounce_hard', 'bounce_soft', 'invalid_address',
] as const;

export function AddSuppressionForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="grid gap-4 md:grid-cols-4"
      action={(formData) => {
        setError(null);
        start(async () => {
          const result = await addSuppression({
            email: formData.get('email'),
            reason: formData.get('reason'),
            notes: formData.get('notes') || undefined,
          });
          if (!result.ok) setError(result.error ?? 'Failed.');
          else router.refresh();
        });
      }}
    >
      <Field label="Email address">
        <input name="email" type="email" required className={inputClass} />
      </Field>
      <Field label="Reason">
        <select name="reason" className={inputClass} defaultValue="manual">
          {REASONS.map((r) => (
            <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </Field>
      <Field label="Note">
        <input name="notes" maxLength={1000} className={inputClass} />
      </Field>
      <div className="flex items-end">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Adding…' : 'Suppress'}
        </Button>
      </div>
      {error && <p className="md:col-span-4 text-sm text-red-700">{error}</p>}
    </form>
  );
}

export function RevokeButton({ id }: { id: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-blue-700 hover:underline">
        revoke
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        className="rounded border border-slate-300 px-2 py-1 text-xs"
        placeholder="Why? (recorded)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button
        disabled={pending || reason.trim().length < 3}
        onClick={() => {
          setError(null);
          start(async () => {
            const result = await revokeSuppression({ id, reason });
            if (!result.ok) setError(result.error ?? 'Failed.');
            else {
              setOpen(false);
              router.refresh();
            }
          });
        }}
      >
        Confirm
      </Button>
      <Button onClick={() => setOpen(false)}>Cancel</Button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
