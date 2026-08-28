import { describe, expect, it } from 'vitest';
import { classifyGraphError, isRetryable, parseRetryAfter, retryDelaySeconds } from '@campaign/core';

describe('classifyGraphError', () => {
  it('treats 429 and explicit throttle codes as retryable throttling', () => {
    expect(classifyGraphError({ status: 429 })).toBe('retryable_throttle');
    expect(classifyGraphError({ code: 'ApplicationThrottled' })).toBe('retryable_throttle');
    expect(classifyGraphError({ status: 503 })).toBe('retryable_throttle');
  });

  it('classifies credential problems as permanent auth failures', () => {
    expect(classifyGraphError({ status: 401 })).toBe('permanent_auth');
    expect(classifyGraphError({ code: 'InvalidAuthenticationToken' })).toBe('permanent_auth');
  });

  it('classifies an application access policy denial as a policy failure', () => {
    expect(classifyGraphError({ status: 403, code: 'ErrorAccessDenied' })).toBe('permanent_policy');
    expect(classifyGraphError({ code: 'MailboxNotEnabledForRESTAPI' })).toBe('permanent_policy');
  });

  it('classifies a rejected recipient as permanent, so it can be auto-suppressed', () => {
    expect(classifyGraphError({ status: 400, code: 'ErrorInvalidRecipients' }))
      .toBe('permanent_recipient');
  });

  it('classifies an oversized message as a content failure, never a retry', () => {
    expect(classifyGraphError({ status: 413 })).toBe('permanent_content');
    expect(classifyGraphError({ code: 'ErrorMessageSizeExceeded' })).toBe('permanent_content');
  });

  // This is the single most important behaviour in the module. Getting it wrong
  // is precisely how a network blip becomes a duplicate email.
  describe('ambiguity', () => {
    it('treats a mid-flight network failure as ambiguous, NOT retryable', () => {
      expect(classifyGraphError({ networkErrorCode: 'ECONNRESET' })).toBe('ambiguous');
      expect(classifyGraphError({ networkErrorCode: 'ETIMEDOUT' })).toBe('ambiguous');
    });

    it('only allows a retry when the request provably never left', () => {
      expect(
        classifyGraphError({ networkErrorCode: 'ECONNREFUSED', requestDefinitelyNotSent: true }),
      ).toBe('retryable_transient');
    });

    it('treats a 500 as ambiguous unless the caller proved nothing was sent', () => {
      expect(classifyGraphError({ status: 500 })).toBe('ambiguous');
      expect(classifyGraphError({ status: 500, requestDefinitelyNotSent: true }))
        .toBe('retryable_transient');
    });

    it('defaults to ambiguous when it knows nothing at all', () => {
      expect(classifyGraphError({})).toBe('ambiguous');
    });

    it('never reports an ambiguous outcome as retryable', () => {
      expect(isRetryable('ambiguous')).toBe(false);
    });
  });
});

describe('parseRetryAfter', () => {
  it('reads a delay expressed in seconds', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter('  30  ')).toBe(30);
  });

  it('reads an HTTP-date and converts it to a delay', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', now)).toBe(60);
  });

  it('returns 0 for a date already in the past', () => {
    const now = new Date('2026-01-01T00:05:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBe(0);
  });

  it('caps absurd values at one day so a bad header cannot park a job forever', () => {
    expect(parseRetryAfter('99999999')).toBe(86_400);
  });

  it('returns undefined when the header is absent or unparseable', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('retryDelaySeconds', () => {
  it('grows exponentially and stays inside the jitter band', () => {
    for (const [attempt, base] of [[1, 30], [2, 60], [3, 120], [4, 240]] as const) {
      const lo = retryDelaySeconds(attempt, () => 0);
      const hi = retryDelaySeconds(attempt, () => 1);
      expect(lo).toBeGreaterThanOrEqual(Math.round(base * 0.8));
      expect(hi).toBeLessThanOrEqual(Math.round(base * 1.2));
    }
  });

  it('caps the delay at two hours', () => {
    expect(retryDelaySeconds(50, () => 1)).toBeLessThanOrEqual(Math.round(7200 * 1.2));
  });

  it('never returns less than five seconds', () => {
    expect(retryDelaySeconds(0, () => 0)).toBeGreaterThanOrEqual(5);
  });
});
