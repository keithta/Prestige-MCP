'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createCampaign } from '@/lib/actions/campaigns';
import { Button, Field, inputClass } from '@/components/ui';

export function NewCampaignForm({ senders }: { senders: Array<{ id: string; mailbox: string }> }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="grid gap-4 md:grid-cols-4"
      action={(formData) => {
        setError(null);
        start(async () => {
          const result = await createCampaign({
            name: formData.get('name'),
            senderAccountId: formData.get('senderAccountId'),
            // Always starts in test mode. Switching to production is a separate,
            // deliberate step.
            sendMode: 'test',
            targetCount: formData.get('targetCount') || null,
          });
          if (!result.ok) setError(result.error ?? 'Failed.');
          else router.push(`/campaigns/${result.data!.id}`);
        });
      }}
    >
      <Field label="Campaign name">
        <input name="name" required maxLength={200} className={inputClass} />
      </Field>
      <Field label="Send from">
        <select name="senderAccountId" required className={inputClass}>
          {senders.map((s) => (
            <option key={s.id} value={s.id}>{s.mailbox}</option>
          ))}
        </select>
      </Field>
      <Field label="How many contacts" hint="Leave blank to use the whole audience">
        <input name="targetCount" type="number" min={1} className={inputClass} />
      </Field>
      <div className="flex items-end">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Creating…' : 'Create campaign'}
        </Button>
      </div>
      {error && <p className="md:col-span-4 text-sm text-red-700">{error}</p>}
    </form>
  );
}
