'use client';

import { useActionState } from 'react';
import { signInAction } from '@/lib/actions/system';
import { Button, Field, inputClass } from '@/components/ui';

export function LoginForm() {
  const [state, action, pending] = useActionState(signInAction, {} as { error?: string });

  return (
    <form action={action} className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
      <Field label="Email">
        <input name="email" type="email" autoComplete="username" required className={inputClass} />
      </Field>
      <Field label="Password">
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </Field>
      {state?.error && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {state.error}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={pending} className="w-full">
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
