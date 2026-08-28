/**
 * Sending-window arithmetic.
 *
 * The DATABASE is authoritative (campaign.is_within_window). This mirror exists
 * so the campaign builder can show "next send: Monday 09:00" without a round
 * trip, and so the DST behaviour is unit-testable.
 */

export interface ScheduleWindow {
  timezone: string;
  /** ISO weekday numbers: 1 = Monday ... 7 = Sunday. */
  allowedDays: number[];
  /** "HH:MM" or "HH:MM:SS", local to `timezone`. */
  windowStart: string;
  windowEnd: string;
  startAt?: Date | null;
  endAt?: Date | null;
}

interface LocalParts {
  isoWeekday: number;
  minutesOfDay: number;
}

/**
 * Wall-clock weekday and time-of-day at `instant`, in `timeZone`.
 *
 * Uses Intl rather than manual offset arithmetic, so DST transitions are
 * handled by the platform's tz database instead of by us getting it wrong.
 */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';

  const weekdayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  const isoWeekday = weekdayMap[get('weekday')] ?? 0;

  // Intl renders midnight as "24" in some locales/engines; normalize to 0.
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return { isoWeekday, minutesOfDay: hour * 60 + minute };
}

export function parseTimeToMinutes(value: string): number {
  const [h = '0', m = '0'] = value.split(':');
  return Number(h) * 60 + Number(m);
}

export function isWithinWindow(window: ScheduleWindow, at: Date = new Date()): boolean {
  if (window.startAt && at < window.startAt) return false;
  if (window.endAt && at >= window.endAt) return false;

  const { isoWeekday, minutesOfDay } = localParts(at, window.timezone);
  if (!window.allowedDays.includes(isoWeekday)) return false;

  const start = parseTimeToMinutes(window.windowStart);
  const end = parseTimeToMinutes(window.windowEnd);
  return minutesOfDay >= start && minutesOfDay < end;
}

/**
 * The next instant the window is open, or null if it never opens again before
 * the campaign's end date. Steps minute-by-minute from the next boundary would
 * be wasteful, so we probe candidate day-starts and then bisect to the minute.
 */
export function nextWindowOpen(window: ScheduleWindow, at: Date = new Date()): Date | null {
  if (isWithinWindow(window, at)) return at;

  const startMinutes = parseTimeToMinutes(window.windowStart);
  // Probe every 15 minutes for up to 9 days. Cheap, and immune to the offset
  // arithmetic mistakes that hand-rolled DST handling invites.
  const stepMs = 15 * 60 * 1000;
  const horizonMs = 9 * 24 * 60 * 60 * 1000;

  let cursor = new Date(Math.ceil(at.getTime() / stepMs) * stepMs);
  const limit = new Date(at.getTime() + horizonMs);

  while (cursor <= limit) {
    if (window.endAt && cursor >= window.endAt) return null;
    if (isWithinWindow(window, cursor)) {
      // Walk back to the exact minute the window opened.
      let precise = cursor;
      for (let i = 0; i < 15; i++) {
        const earlier = new Date(precise.getTime() - 60_000);
        if (earlier <= at || !isWithinWindow(window, earlier)) break;
        precise = earlier;
      }
      return precise;
    }
    cursor = new Date(cursor.getTime() + stepMs);
  }
  void startMinutes;
  return null;
}

/**
 * How many emails can still go out today, given the caps and what has already
 * been sent. Drives the "this campaign will finish on Thursday" estimate.
 */
export function remainingCapacity(opts: {
  hourlyLimit: number;
  dailyLimit: number;
  sentThisHour: number;
  sentToday: number;
}): { hourly: number; daily: number; effective: number } {
  const hourly = Math.max(0, opts.hourlyLimit - opts.sentThisHour);
  const daily = Math.max(0, opts.dailyLimit - opts.sentToday);
  return { hourly, daily, effective: Math.min(hourly, daily) };
}
