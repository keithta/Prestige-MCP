/** Errors raised by the Graph client, carrying everything an operator needs. */
import type { FailureClass } from '@campaign/core';

export class GraphError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly failureClass: FailureClass;
  readonly retryAfterSeconds: number | undefined;
  /** Microsoft's correlation ids. Quote these verbatim in a support case. */
  readonly requestId: string | undefined;
  readonly clientRequestId: string | undefined;
  readonly bodyExcerpt: string | undefined;

  constructor(
    message: string,
    init: {
      status?: number | undefined;
      code?: string | undefined;
      failureClass: FailureClass;
      retryAfterSeconds?: number | undefined;
      requestId?: string | undefined;
      clientRequestId?: string | undefined;
      bodyExcerpt?: string | undefined;
      cause?: unknown;
    },
  ) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'GraphError';
    this.status = init.status;
    this.code = init.code;
    this.failureClass = init.failureClass;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.requestId = init.requestId;
    this.clientRequestId = init.clientRequestId;
    this.bodyExcerpt = init.bodyExcerpt;
  }
}

/**
 * A send whose outcome we cannot determine. Raised instead of a retryable error
 * whenever a request may already have been delivered -- this is what stops the
 * system from turning a network blip into a duplicate email.
 */
export class AmbiguousSendError extends GraphError {
  constructor(message: string, init: Omit<ConstructorParameters<typeof GraphError>[1], 'failureClass'>) {
    super(message, { ...init, failureClass: 'ambiguous' });
    this.name = 'AmbiguousSendError';
  }
}
