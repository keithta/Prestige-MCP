'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  addTestRecipient, createOperator, createSender, setComplianceSettings,
  setGlobalSendEnabled, setProductionMode, setSenderStatus,
} from '@/lib/actions/system';
import { Button, Field, inputClass } from '@/components/ui';

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success?: string) {
    setError(null);
    setMessage(null);
    start(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? 'Failed.');
      else {
        if (success) setMessage(success);
        router.refresh();
      }
    });
  }
  return { run, error, message, pending };
}

/**
 * Turning production sending on is the single most consequential switch in the
 * system, so it asks for a typed phrase. Turning it off is one click.
 */
export function ProductionModeControl({ enabled }: { enabled: boolean }) {
  const { run, error, pending } = useAction();
  const [confirmation, setConfirmation] = useState('');
  const [open, setOpen] = useState(false);

  if (enabled) {
    return (
      <div>
        <Button disabled={pending} onClick={() => run(() => setProductionMode({ enabled: false }))}>
          Disable production sending
        </Button>
        {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
      </div>
    );
  }

  if (!open) {
    return <Button variant="danger" onClick={() => setOpen(true)}>Enable production sending</Button>;
  }

  return (
    <div className="w-full rounded border border-red-300 bg-red-50 p-3">
      <p className="text-xs text-red-900">
        This allows campaigns in production mode to send to any address in their audience, not just
        the test allowlist. Confirm your Entra app registration and Exchange application access
        policy are correct first.
      </p>
      <input
        className={`${inputClass} mt-2`}
        placeholder="Type ENABLE PRODUCTION SENDING"
        value={confirmation}
        onChange={(e) => setConfirmation(e.target.value)}
      />
      <div className="mt-2 flex gap-2">
        <Button
          variant="danger"
          disabled={pending || confirmation !== 'ENABLE PRODUCTION SENDING'}
          onClick={() =>
            run(() =>
              setProductionMode({ enabled: true, confirmation: 'ENABLE PRODUCTION SENDING' }),
            )
          }
        >
          Enable
        </Button>
        <Button onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </div>
  );
}

export function GlobalSendControl({ enabled }: { enabled: boolean }) {
  const { run, error, pending } = useAction();
  return (
    <div>
      <Button
        disabled={pending}
        onClick={() => run(() => setGlobalSendEnabled({ enabled: !enabled }))}
      >
        {enabled ? 'Switch off global sending' : 'Switch on global sending'}
      </Button>
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </div>
  );
}

export function SenderStatusControl({ id, status }: { id: string; status: string }) {
  const { run, pending } = useAction();
  return (
    <select
      className="rounded border border-slate-300 px-2 py-1 text-xs"
      value={status}
      disabled={pending}
      onChange={(e) =>
        run(() =>
          setSenderStatus({
            senderId: id,
            status: e.target.value,
            reason: 'Changed from Settings',
          }),
        )
      }
    >
      <option value="active">active</option>
      <option value="paused">paused</option>
      <option value="disabled">disabled</option>
    </select>
  );
}

export function NewSenderForm() {
  const { run, error, message, pending } = useAction();
  return (
    <form
      className="grid gap-3 md:grid-cols-6"
      action={(formData) =>
        run(
          () =>
            createSender({
              mailboxAddress: formData.get('mailboxAddress'),
              displayName: formData.get('displayName') || undefined,
              tenantId: formData.get('tenantId') || undefined,
              timezone: formData.get('timezone'),
              hourlyLimit: formData.get('hourlyLimit'),
              dailyLimit: formData.get('dailyLimit'),
              minIntervalSeconds: formData.get('minIntervalSeconds'),
            }),
          'Mailbox added.',
        )
      }
    >
      <Field label="Mailbox address">
        <input name="mailboxAddress" type="email" required className={inputClass} />
      </Field>
      <Field label="Display name">
        <input name="displayName" className={inputClass} />
      </Field>
      <Field label="Tenant id" hint="Checked before sending.">
        <input name="tenantId" className={inputClass} />
      </Field>
      <Field label="Timezone">
        <input name="timezone" defaultValue="America/Toronto" className={inputClass} />
      </Field>
      <Field label="Hourly / daily">
        <div className="flex gap-1">
          <input name="hourlyLimit" type="number" defaultValue={60} min={1} className={inputClass} />
          <input name="dailyLimit" type="number" defaultValue={500} min={1} className={inputClass} />
        </div>
      </Field>
      <div className="flex items-end gap-2">
        <input name="minIntervalSeconds" type="number" defaultValue={4} min={0} className={`${inputClass} w-16`} title="Minimum gap in seconds" />
        <Button type="submit" variant="primary" disabled={pending}>Add</Button>
      </div>
      {error && <p className="md:col-span-6 text-sm text-red-700">{error}</p>}
      {message && <p className="md:col-span-6 text-sm text-green-700">{message}</p>}
    </form>
  );
}

export function TestRecipientForm() {
  const { run, error, pending } = useAction();
  return (
    <form
      className="flex gap-2"
      action={(formData) =>
        run(() => addTestRecipient({ email: formData.get('email'), note: formData.get('note') || undefined }))
      }
    >
      <input name="email" type="email" required placeholder="you@example.com" className={inputClass} />
      <input name="note" placeholder="Note" className={inputClass} />
      <Button type="submit" disabled={pending}>Add</Button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </form>
  );
}

export function ComplianceForm({ settings }: { settings: Record<string, unknown> }) {
  const { run, error, message, pending } = useAction();
  return (
    <form
      className="grid gap-3 md:grid-cols-2"
      action={(formData) =>
        run(
          () =>
            setComplianceSettings({
              orgName: formData.get('orgName'),
              postalAddress: formData.get('postalAddress'),
              replyTo: formData.get('replyTo') || '',
              appBaseUrl: formData.get('appBaseUrl'),
            }),
          'Saved.',
        )
      }
    >
      <Field label="Organisation name">
        <input name="orgName" defaultValue={String(settings.org_name ?? '')} required className={inputClass} />
      </Field>
      <Field label="Reply-to address">
        <input name="replyTo" type="email" defaultValue={String(settings.reply_to ?? '')} className={inputClass} />
      </Field>
      <Field label="Physical postal address" hint="Legally required in every campaign footer.">
        <input name="postalAddress" defaultValue={String(settings.postal_address ?? '')} required className={inputClass} />
      </Field>
      <Field label="Application URL" hint="Used to build unsubscribe links, e.g. https://campaigns.example.com">
        <input name="appBaseUrl" type="url" defaultValue={String(settings.app_base_url ?? '')} required className={inputClass} />
      </Field>
      <div className="md:col-span-2">
        <Button type="submit" variant="primary" disabled={pending}>Save</Button>
        {error && <p className="mt-1 text-sm text-red-700">{error}</p>}
        {message && <p className="mt-1 text-sm text-green-700">{message}</p>}
      </div>
    </form>
  );
}

export function NewOperatorForm() {
  const { run, error, message, pending } = useAction();
  return (
    <form
      className="grid gap-3 md:grid-cols-5"
      action={(formData) =>
        run(
          () =>
            createOperator({
              email: formData.get('email'),
              password: formData.get('password'),
              role: formData.get('role'),
              fullName: formData.get('fullName') || undefined,
            }),
          'Operator created.',
        )
      }
    >
      <Field label="Email">
        <input name="email" type="email" required className={inputClass} />
      </Field>
      <Field label="Full name">
        <input name="fullName" className={inputClass} />
      </Field>
      <Field label="Password" hint="At least 12 characters.">
        <input name="password" type="password" minLength={12} required className={inputClass} />
      </Field>
      <Field label="Role">
        <select name="role" defaultValue="operator" className={inputClass}>
          <option value="viewer">viewer — read only</option>
          <option value="operator">operator — build and run campaigns</option>
          <option value="approver">approver — may approve campaigns</option>
          <option value="owner">owner — everything, including production mode</option>
        </select>
      </Field>
      <div className="flex items-end">
        <Button type="submit" variant="primary" disabled={pending}>Create</Button>
      </div>
      {error && <p className="md:col-span-5 text-sm text-red-700">{error}</p>}
      {message && <p className="md:col-span-5 text-sm text-green-700">{message}</p>}
    </form>
  );
}
