/**
 * Classification of Microsoft Graph failures, and the backoff schedule.
 *
 * The worker uses this to decide WHAT KIND of failure occurred. It does not
 * decide what happens next -- the database does, in campaign.mark_failed().
 */
import type { FailureClass } from './types.js';

export interface GraphErrorShape {
  status?: number | undefined;
  code?: string | undefined;
  message?: string | undefined;
  retryAfterSeconds?: number | undefined;
  /** True when the request definitely never reached Microsoft. */
  requestDefinitelyNotSent?: boolean | undefined;
  /** Node network error code, e.g. ETIMEDOUT, ECONNRESET. */
  networkErrorCode?: string | undefined;
}

/** Graph error codes that mean this recipient will never work. */
const PERMANENT_RECIPIENT_CODES = new Set([
  'ErrorInvalidRecipients',
  'ErrorInvalidRecipientAddress',
  'ErrorNonExistentMailbox',
  'ErrorRecipientNotFound',
  'InvalidRecipients',
]);

/** Codes that mean our credentials or consent are wrong. */
const PERMANENT_AUTH_CODES = new Set([
  'InvalidAuthenticationToken',
  'AuthenticationFailed',
  'TokenExpired',
  'CompactToken_ParsingFailed',
  'unauthorized_client',
  'invalid_client',
]);

/** Codes that mean policy or licensing forbids this send. */
const PERMANENT_POLICY_CODES = new Set([
  'ErrorAccessDenied',
  'ErrorSendAsDenied',
  'ApplicationAccessPolicyDenied',
  'MailboxNotEnabledForRESTAPI',
  'MailboxNotSupportedForRESTAPI',
  'ErrorMailboxNotEnabledForRESTAPI',
  'Authorization_RequestDenied',
]);

/** Codes about the message itself: retrying identical content cannot help. */
const PERMANENT_CONTENT_CODES = new Set([
  'ErrorMessageSizeExceeded',
  'ErrorInvalidItem',
  'RequestBodyTooLarge',
  'ErrorMessageDispositionRequired',
]);

const THROTTLE_CODES = new Set([
  'ApplicationThrottled',
  'TooManyRequests',
  'ActivityLimitReached',
  'RequestThrottled',
  'ErrorTooManyObjectsOpened',
  'QuotaExceeded',
  'ErrorExceededMessageLimit',
]);

const TRANSIENT_NETWORK_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND',
  'EPIPE', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

/**
 * Map a Graph failure onto a class.
 *
 * The critical case is `ambiguous`: a request that MAY have been delivered.
 * Classifying one of those as retryable is exactly how duplicate emails happen,
 * so anything we cannot prove did not arrive is ambiguous by default.
 */
export function classifyGraphError(err: GraphErrorShape): FailureClass {
  const code = err.code ?? '';
  const status = err.status;

  if (THROTTLE_CODES.has(code) || status === 429) return 'retryable_throttle';
  if (status === 503 || status === 504) return 'retryable_throttle';

  if (PERMANENT_AUTH_CODES.has(code) || status === 401) return 'permanent_auth';
  if (PERMANENT_POLICY_CODES.has(code) || status === 403) return 'permanent_policy';
  if (PERMANENT_RECIPIENT_CODES.has(code)) return 'permanent_recipient';
  if (PERMANENT_CONTENT_CODES.has(code) || status === 413) return 'permanent_content';

  // A network failure we can PROVE happened before the request was written is
  // safe to retry. Anything else that died mid-flight is not.
  if (err.networkErrorCode && TRANSIENT_NETWORK_CODES.has(err.networkErrorCode)) {
    return err.requestDefinitelyNotSent === true ? 'retryable_transient' : 'ambiguous';
  }

  if (status !== undefined && status >= 500) {
    // A 5xx means the server answered, so the request definitely arrived; for a
    // send that is ambiguous unless the caller established otherwise.
    return err.requestDefinitelyNotSent === true ? 'retryable_transient' : 'ambiguous';
  }

  if (status !== undefined && status >= 400 && status < 500) {
    // A 4xx is a definite rejection: nothing was sent.
    return 'permanent_content';
  }

  return 'ambiguous';
}

export function isRetryable(cls: FailureClass): boolean {
  return cls === 'retryable_throttle' || cls === 'retryable_transient';
}

/**
 * Exponential backoff with jitter, mirroring campaign.retry_delay_seconds().
 * The database is authoritative; this exists for client-side pacing and tests.
 */
export function retryDelaySeconds(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(7200, 30 * Math.pow(2, Math.max(attempt - 1, 0)));
  const jittered = base * (0.8 + random() * 0.4);
  return Math.max(5, Math.round(jittered));
}

/** Parse a Retry-After header, which may be seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now: Date = new Date()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();

  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.min(Math.ceil(asSeconds), 86_400);
  }

  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const delta = Math.ceil((asDate - now.getTime()) / 1000);
    return delta > 0 ? Math.min(delta, 86_400) : 0;
  }
  return undefined;
}
