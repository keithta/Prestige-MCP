/** Prometheus-format counters, exposed at /metrics. */
export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  readonly startedAt = Date.now();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  get(name: string): number {
    return this.counters.get(name) ?? this.gauges.get(name) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    const emit = (name: string, value: number, type: 'counter' | 'gauge', help: string) => {
      lines.push(`# HELP campaign_${name} ${help}`);
      lines.push(`# TYPE campaign_${name} ${type}`);
      lines.push(`campaign_${name} ${value}`);
    };

    emit('worker_uptime_seconds', Math.floor((Date.now() - this.startedAt) / 1000), 'gauge',
      'Seconds since the worker started.');

    const help: Record<string, string> = {
      jobs_claimed_total: 'Jobs leased from the database.',
      jobs_sent_total: 'Jobs Microsoft Graph accepted.',
      jobs_failed_total: 'Jobs that failed a send attempt.',
      jobs_refused_total: 'Jobs refused by the pre-flight authorization check.',
      jobs_ambiguous_total: 'Sends whose outcome could not be determined.',
      duplicates_blocked_total: 'Duplicate send attempts blocked by the database.',
      poll_cycles_total: 'Completed poll cycles.',
      poll_errors_total: 'Poll cycles that ended in an error.',
      leases_reaped_total: 'Expired leases returned to the queue.',
      leases_reconciling_total: 'Expired leases parked for reconciliation.',
      reconciled_sent_total: 'Ambiguous sends confirmed as delivered.',
      reconciled_not_sent_total: 'Ambiguous sends confirmed as not delivered.',
      reconciled_undetermined_total: 'Ambiguous sends that remain undecidable.',
    };
    for (const [name, value] of this.counters) {
      emit(name, value, 'counter', help[name] ?? name.replace(/_/g, ' '));
    }

    const gaugeHelp: Record<string, string> = {
      queue_depth: 'Jobs currently queued.',
      queue_ready_now: 'Queued jobs past their availability gate.',
      queue_in_flight: 'Jobs claimed or sending.',
      queue_needs_reconciliation: 'Jobs awaiting reconciliation.',
      queue_expired_leases: 'Leases past their expiry.',
      emergency_stop: 'Whether the global emergency stop is engaged (1 = engaged).',
      global_send_enabled: 'Whether global sending is enabled (1 = enabled).',
      production_mode: 'Whether production mode is enabled (1 = enabled).',
      open_critical_alerts: 'Unresolved critical alerts.',
    };
    for (const [name, value] of this.gauges) {
      emit(name, value, 'gauge', gaugeHelp[name] ?? name.replace(/_/g, ' '));
    }

    return lines.join('\n') + '\n';
  }
}
