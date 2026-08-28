import { describe, expect, it } from 'vitest';
import { isWithinWindow, localParts, nextWindowOpen, remainingCapacity } from '@campaign/core';

const weekdays9to5 = {
  timezone: 'America/Toronto',
  allowedDays: [1, 2, 3, 4, 5],
  windowStart: '09:00',
  windowEnd: '17:00',
};

describe('localParts', () => {
  it('reports the wall clock in the requested timezone, not UTC', () => {
    // 2026-03-02 is a Monday. 14:00 UTC is 09:00 in Toronto (EST, UTC-5).
    const parts = localParts(new Date('2026-03-02T14:00:00Z'), 'America/Toronto');
    expect(parts.isoWeekday).toBe(1);
    expect(parts.minutesOfDay).toBe(9 * 60);
  });

  it('normalizes midnight to 0 rather than 24', () => {
    const parts = localParts(new Date('2026-03-02T05:00:00Z'), 'America/Toronto');
    expect(parts.minutesOfDay).toBe(0);
  });
});

describe('isWithinWindow', () => {
  it('is open on a weekday inside the hours', () => {
    expect(isWithinWindow(weekdays9to5, new Date('2026-03-02T14:30:00Z'))).toBe(true);
  });

  it('is closed before the window opens', () => {
    expect(isWithinWindow(weekdays9to5, new Date('2026-03-02T13:30:00Z'))).toBe(false);
  });

  it('is closed at exactly the end of the window (end is exclusive)', () => {
    // 22:00 UTC = 17:00 Toronto.
    expect(isWithinWindow(weekdays9to5, new Date('2026-03-02T22:00:00Z'))).toBe(false);
    expect(isWithinWindow(weekdays9to5, new Date('2026-03-02T21:59:00Z'))).toBe(true);
  });

  it('is closed at the weekend', () => {
    // 2026-03-07 is a Saturday.
    expect(isWithinWindow(weekdays9to5, new Date('2026-03-07T15:00:00Z'))).toBe(false);
  });

  // DST is where hand-rolled offset arithmetic goes wrong, so it gets its own
  // test. North American DST began 2026-03-08.
  describe('daylight saving', () => {
    it('tracks the wall clock across a spring-forward transition', () => {
      // Before: EST (UTC-5). 14:00Z is 09:00 local -> open.
      expect(isWithinWindow(weekdays9to5, new Date('2026-03-06T14:00:00Z'))).toBe(true);
      // After: EDT (UTC-4). 14:00Z is now 10:00 local -> still open.
      expect(isWithinWindow(weekdays9to5, new Date('2026-03-09T14:00:00Z'))).toBe(true);
      // And 13:00Z is 09:00 local after the shift -> open; it was 08:00 before.
      expect(isWithinWindow(weekdays9to5, new Date('2026-03-09T13:00:00Z'))).toBe(true);
      expect(isWithinWindow(weekdays9to5, new Date('2026-03-06T13:00:00Z'))).toBe(false);
    });
  });

  it('respects campaign start and end dates', () => {
    const bounded = {
      ...weekdays9to5,
      startAt: new Date('2026-03-03T00:00:00Z'),
      endAt: new Date('2026-03-05T00:00:00Z'),
    };
    expect(isWithinWindow(bounded, new Date('2026-03-02T14:30:00Z'))).toBe(false);
    expect(isWithinWindow(bounded, new Date('2026-03-03T14:30:00Z'))).toBe(true);
    expect(isWithinWindow(bounded, new Date('2026-03-06T14:30:00Z'))).toBe(false);
  });
});

describe('nextWindowOpen', () => {
  it('returns now when the window is already open', () => {
    const now = new Date('2026-03-02T14:30:00Z');
    expect(nextWindowOpen(weekdays9to5, now)).toEqual(now);
  });

  it('finds this morning s opening from before the window', () => {
    const next = nextWindowOpen(weekdays9to5, new Date('2026-03-02T12:00:00Z'));
    expect(next).not.toBeNull();
    expect(localParts(next!, weekdays9to5.timezone).minutesOfDay).toBe(9 * 60);
    expect(localParts(next!, weekdays9to5.timezone).isoWeekday).toBe(1);
  });

  it('skips the weekend to Monday morning', () => {
    // Friday evening.
    const next = nextWindowOpen(weekdays9to5, new Date('2026-03-06T23:00:00Z'));
    expect(next).not.toBeNull();
    expect(localParts(next!, weekdays9to5.timezone).isoWeekday).toBe(1);
    expect(localParts(next!, weekdays9to5.timezone).minutesOfDay).toBe(9 * 60);
  });

  it('returns null when the campaign ends before the window can reopen', () => {
    const ending = {
      ...weekdays9to5,
      endAt: new Date('2026-03-07T00:00:00Z'),
    };
    expect(nextWindowOpen(ending, new Date('2026-03-06T23:00:00Z'))).toBeNull();
  });
});

describe('remainingCapacity', () => {
  it('is bounded by whichever limit is tighter', () => {
    expect(remainingCapacity({ hourlyLimit: 30, dailyLimit: 200, sentThisHour: 25, sentToday: 199 }))
      .toEqual({ hourly: 5, daily: 1, effective: 1 });
  });

  it('never goes negative when a limit was lowered after sending', () => {
    expect(remainingCapacity({ hourlyLimit: 10, dailyLimit: 10, sentThisHour: 50, sentToday: 50 }))
      .toEqual({ hourly: 0, daily: 0, effective: 0 });
  });
});
