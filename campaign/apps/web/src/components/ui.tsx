import type { ReactNode } from 'react';

export function Card({
  title, children, actions, tone = 'default',
}: {
  title?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  tone?: 'default' | 'danger' | 'warn';
}) {
  const border =
    tone === 'danger' ? 'border-red-300' : tone === 'warn' ? 'border-amber-300' : 'border-slate-200';
  return (
    <section className={`rounded-lg border ${border} bg-white shadow-sm`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-slate-800">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({
  label, value, tone = 'default', hint,
}: {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'ok' | 'warn' | 'danger';
  hint?: string;
}) {
  const color =
    tone === 'ok' ? 'text-green-700'
      : tone === 'warn' ? 'text-amber-700'
      : tone === 'danger' ? 'text-red-700'
      : 'text-slate-900';
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

const BADGE_TONES: Record<string, string> = {
  sent: 'bg-green-100 text-green-800 border-green-200',
  running: 'bg-green-100 text-green-800 border-green-200',
  active: 'bg-green-100 text-green-800 border-green-200',
  ready: 'bg-blue-100 text-blue-800 border-blue-200',
  queued: 'bg-blue-100 text-blue-800 border-blue-200',
  claimed: 'bg-blue-100 text-blue-800 border-blue-200',
  sending: 'bg-blue-100 text-blue-800 border-blue-200',
  approved: 'bg-blue-100 text-blue-800 border-blue-200',
  retrying: 'bg-amber-100 text-amber-800 border-amber-200',
  waiting: 'bg-amber-100 text-amber-800 border-amber-200',
  paused: 'bg-amber-100 text-amber-800 border-amber-200',
  pending: 'bg-slate-100 text-slate-700 border-slate-200',
  pending_approval: 'bg-amber-100 text-amber-800 border-amber-200',
  draft: 'bg-slate-100 text-slate-700 border-slate-200',
  held: 'bg-amber-100 text-amber-800 border-amber-200',
  needs_reconciliation: 'bg-red-100 text-red-800 border-red-200',
  failed_permanent: 'bg-red-100 text-red-800 border-red-200',
  failed: 'bg-red-100 text-red-800 border-red-200',
  bounced: 'bg-red-100 text-red-800 border-red-200',
  complained: 'bg-red-100 text-red-800 border-red-200',
  stopped: 'bg-red-100 text-red-800 border-red-200',
  disabled: 'bg-red-100 text-red-800 border-red-200',
  suppressed: 'bg-purple-100 text-purple-800 border-purple-200',
  cancelled: 'bg-slate-100 text-slate-600 border-slate-200',
  skipped: 'bg-slate-100 text-slate-600 border-slate-200',
  completed: 'bg-slate-100 text-slate-700 border-slate-200',
};

export function Badge({ value }: { value: string }) {
  const tone = BADGE_TONES[value] ?? 'bg-slate-100 text-slate-700 border-slate-200';
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${tone}`}>
      {value.replace(/_/g, ' ')}
    </span>
  );
}

export function Button({
  children, variant = 'default', ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger';
}) {
  const styles =
    variant === 'primary'
      ? 'bg-blue-700 text-white hover:bg-blue-800 border-blue-700'
      : variant === 'danger'
        ? 'bg-red-700 text-white hover:bg-red-800 border-red-700'
        : 'bg-white text-slate-800 hover:bg-slate-50 border-slate-300';
  return (
    <button
      {...props}
      className={`rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed ${styles} ${props.className ?? ''}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600';

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-slate-500">{children}</p>;
}

export function Table({
  head, children,
}: {
  head: ReactNode[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1],
  ];
  const fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, seconds] of units) {
    if (Math.abs(deltaSeconds) >= seconds || unit === 'second') {
      return fmt.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return '—';
}
