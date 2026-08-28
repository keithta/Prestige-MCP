'use client';

import { useState, useTransition } from 'react';
import { acknowledgeAlert, resolveAlert, setEmergencyStop } from '@/lib/actions/system';
import { Button, inputClass } from '@/components/ui';

/**
 * The emergency stop. Engaging it asks for a reason and a typed phrase, because
 * this is the control someone reaches for in a hurry and the audit record of
 * WHY is the part that matters afterwards.
 */
export function EmergencyStopControl({ engaged }: { engaged: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const phrase = engaged ? 'RESUME' : 'STOP EVERYTHING';

  function submit() {
    setError(null);
    start(async () => {
      const result = engaged
        ? await setEmergencyStop({ engaged: false, confirmation: 'RESUME' })
        : await setEmergencyStop({ engaged: true, reason, confirmation: 'STOP EVERYTHING' });
      if (!result.ok) setError(result.error ?? 'Failed.');
      else {
        setOpen(false);
        setReason('');
        setConfirmation('');
      }
    });
  }

  if (!open) {
    return (
      <Button variant={engaged ? 'default' : 'danger'} onClick={() => setOpen(true)}>
        {engaged ? 'Release emergency stop' : 'Emergency stop'}
      </Button>
    );
  }

  return (
    <div className="w-96 rounded-lg border border-red-300 bg-white p-4 shadow-lg">
      <h3 className="text-sm font-semibold text-red-800">
        {engaged ? 'Release the emergency stop?' : 'Stop all sending immediately?'}
      </h3>
      <p className="mt-1 text-xs text-slate-600">
        {engaged
          ? 'Campaigns that were running will begin sending again on the next poll.'
          : 'Every campaign stops at once. Nothing is lost — queued emails stay queued.'}
      </p>

      {!engaged && (
        <input
          className={`${inputClass} mt-3`}
          placeholder="Why are you stopping? (recorded in the audit trail)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      )}
      <input
        className={`${inputClass} mt-2`}
        placeholder={`Type ${phrase} to confirm`}
        value={confirmation}
        onChange={(e) => setConfirmation(e.target.value)}
      />

      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}

      <div className="mt-3 flex gap-2">
        <Button
          variant="danger"
          disabled={pending || confirmation !== phrase || (!engaged && reason.trim().length < 3)}
          onClick={submit}
        >
          {pending ? 'Working…' : engaged ? 'Release' : 'Stop everything'}
        </Button>
        <Button onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
      </div>
    </div>
  );
}

export function AlertActions({ id, acknowledged }: { id: number; acknowledged: boolean }) {
  const [pending, start] = useTransition();
  return (
    <div className="flex shrink-0 gap-2">
      {!acknowledged && (
        <Button disabled={pending} onClick={() => start(async () => { await acknowledgeAlert({ id }); })}>
          Acknowledge
        </Button>
      )}
      <Button disabled={pending} onClick={() => start(async () => { await resolveAlert({ id }); })}>
        Resolve
      </Button>
    </div>
  );
}
