/**
 * The Microsoft Graph client. The ONLY code in the system that talks to Graph.
 *
 * The default send strategy is draft-then-send:
 *
 *   1. POST /users/{mailbox}/messages          -> creates a draft, returns its id
 *   2. POST /users/{mailbox}/messages/{id}/send -> 202 Accepted
 *
 * It costs two API calls instead of one, and that is the point. If step 2
 * returns ambiguously (timeout, reset, 5xx), the outcome is RECOVERABLE: the
 * draft id is already persisted, so we can look the message up. A draft still
 * sitting in Drafts proves it did not send; its absence plus a Sent Items match
 * on the x-campaign-job-id header proves it did. A one-shot sendMail cannot be
 * disambiguated at all, and guessing is exactly how duplicate emails happen.
 */
import { classifyGraphError, parseRetryAfter, type GraphConfig } from '@campaign/core';
import { AmbiguousSendError, GraphError } from './errors.js';
import type { TokenProvider } from './auth.js';

export interface SendableMessage {
  jobId: string;
  clientRequestId: string;
  toAddress: string;
  toName?: string | null;
  subject: string;
  bodyHtml?: string | null;
  bodyText?: string | null;
  /** Rendered per-job unsubscribe URL; becomes the List-Unsubscribe header. */
  unsubscribeUrl?: string | null;
  replyTo?: string | null;
}

export interface SendResult {
  graphMessageId: string | null;
  internetMessageId: string | null;
  httpStatus: number;
  requestId: string | null;
  draftId: string | null;
}

/** Header used to identify our messages in Sent Items during reconciliation. */
export const JOB_ID_HEADER = 'x-campaign-job-id';

interface GraphResponse {
  status: number;
  requestId: string | null;
  clientRequestId: string | null;
  retryAfterSeconds: number | undefined;
  body: unknown;
  rawBody: string;
}

export class GraphClient {
  constructor(
    private readonly config: GraphConfig,
    private readonly tokens: TokenProvider,
    private readonly onDraftCreated?: (jobId: string, draftId: string) => Promise<void>,
  ) {}

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; clientRequestId?: string; retryOn401?: boolean } = {},
  ): Promise<GraphResponse> {
    const token = await this.tokens.getAccessToken();
    const url = `${this.config.GRAPH_BASE_URL}${path}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.GRAPH_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          // Stable across retries, so Microsoft's logs and ours line up.
          ...(opts.clientRequestId ? { 'client-request-id': opts.clientRequestId } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      const cause = err as NodeJS.ErrnoException & { name?: string };
      const isTimeout = cause.name === 'AbortError';
      // We do not know whether the request landed. Never assume it did not.
      throw new AmbiguousSendError(
        isTimeout
          ? `Graph request timed out after ${this.config.GRAPH_TIMEOUT_MS}ms: ${method} ${path}`
          : `Graph request failed in transit: ${method} ${path} (${cause.code ?? cause.message})`,
        {
          code: cause.code ?? (isTimeout ? 'ETIMEDOUT' : 'ENETWORK'),
          clientRequestId: opts.clientRequestId,
          cause: err,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    const rawBody = await res.text();
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }

    const response: GraphResponse = {
      status: res.status,
      requestId: res.headers.get('request-id') ?? res.headers.get('x-ms-ags-diagnostic'),
      clientRequestId: res.headers.get('client-request-id'),
      retryAfterSeconds: parseRetryAfter(res.headers.get('retry-after')),
      body,
      rawBody,
    };

    if (res.ok) return response;

    // One transparent retry on 401: an access token can expire between our
    // proactive refresh window and the request landing.
    if (res.status === 401 && opts.retryOn401 !== false) {
      this.tokens.invalidate();
      return this.request(method, path, { ...opts, retryOn401: false });
    }

    throw this.toGraphError(response, `${method} ${path}`);
  }

  private toGraphError(res: GraphResponse, context: string): GraphError {
    const err = res.body as { error?: { code?: string; message?: string } } | null;
    const code = err?.error?.code;
    const message = err?.error?.message ?? res.rawBody.slice(0, 500);

    const failureClass = classifyGraphError({
      status: res.status,
      code,
      message,
      retryAfterSeconds: res.retryAfterSeconds,
      // The server answered, so the request definitely arrived. For a 4xx that
      // means a definite rejection; a 5xx is handled as ambiguous by the
      // classifier unless the caller knows better.
      requestDefinitelyNotSent: res.status < 500,
    });

    return new GraphError(`Graph ${context} failed: ${res.status} ${code ?? ''} ${message}`.trim(), {
      status: res.status,
      code,
      failureClass,
      retryAfterSeconds: res.retryAfterSeconds,
      requestId: res.requestId ?? undefined,
      clientRequestId: res.clientRequestId ?? undefined,
      bodyExcerpt: res.rawBody.slice(0, 1000),
    });
  }

  private buildMessage(mailbox: string, msg: SendableMessage): Record<string, unknown> {
    const headers: Array<{ name: string; value: string }> = [
      // Custom internet headers must be x-prefixed. This is the evidence that
      // makes an ambiguous send resolvable.
      { name: JOB_ID_HEADER, value: msg.jobId },
    ];
    if (msg.unsubscribeUrl) {
      headers.push({ name: 'List-Unsubscribe', value: `<${msg.unsubscribeUrl}>` });
      headers.push({ name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' });
    }

    const useHtml = Boolean(msg.bodyHtml && msg.bodyHtml.trim());
    return {
      subject: msg.subject,
      body: {
        contentType: useHtml ? 'HTML' : 'Text',
        content: useHtml ? msg.bodyHtml : (msg.bodyText ?? ''),
      },
      toRecipients: [
        {
          emailAddress: {
            address: msg.toAddress,
            ...(msg.toName ? { name: msg.toName } : {}),
          },
        },
      ],
      ...(msg.replyTo
        ? { replyTo: [{ emailAddress: { address: msg.replyTo } }] }
        : {}),
      internetMessageHeaders: headers,
      from: { emailAddress: { address: mailbox } },
    };
  }

  /** Draft-then-send. The recoverable path, and the default. */
  async sendViaDraft(mailbox: string, msg: SendableMessage): Promise<SendResult> {
    const encoded = encodeURIComponent(mailbox);

    const created = await this.request('POST', `/users/${encoded}/messages`, {
      body: this.buildMessage(mailbox, msg),
      clientRequestId: msg.clientRequestId,
    });

    const draft = created.body as { id?: string; internetMessageId?: string } | null;
    const draftId = draft?.id;
    if (!draftId) {
      throw new GraphError('Graph created a draft but returned no id', {
        status: created.status,
        failureClass: 'retryable_transient',
        requestId: created.requestId ?? undefined,
        clientRequestId: msg.clientRequestId,
      });
    }

    // Persist the draft id BEFORE sending. If the send is ambiguous, this is
    // what lets us look the message up instead of guessing.
    if (this.onDraftCreated) {
      await this.onDraftCreated(msg.jobId, draftId);
    }

    const sent = await this.request(
      'POST',
      `/users/${encoded}/messages/${encodeURIComponent(draftId)}/send`,
      { clientRequestId: msg.clientRequestId },
    );

    return {
      graphMessageId: draftId,
      internetMessageId: draft?.internetMessageId ?? null,
      httpStatus: sent.status,
      requestId: sent.requestId,
      draftId,
    };
  }

  /** One-shot sendMail. Faster, but its outcome cannot be disambiguated. */
  async sendDirect(mailbox: string, msg: SendableMessage): Promise<SendResult> {
    const encoded = encodeURIComponent(mailbox);
    const res = await this.request('POST', `/users/${encoded}/sendMail`, {
      body: { message: this.buildMessage(mailbox, msg), saveToSentItems: true },
      clientRequestId: msg.clientRequestId,
    });
    return {
      graphMessageId: null,
      internetMessageId: null,
      httpStatus: res.status,
      requestId: res.requestId,
      draftId: null,
    };
  }

  async send(mailbox: string, msg: SendableMessage): Promise<SendResult> {
    return this.config.GRAPH_SEND_STRATEGY === 'send_mail'
      ? this.sendDirect(mailbox, msg)
      : this.sendViaDraft(mailbox, msg);
  }

  // -------------------------------------------------------------------------
  // Reconciliation. Answers "did this actually send?" from evidence.
  // -------------------------------------------------------------------------

  /** True if the draft is still sitting in Drafts, which proves it did NOT send. */
  async draftStillExists(mailbox: string, draftId: string): Promise<boolean> {
    try {
      const res = await this.request(
        'GET',
        `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(draftId)}`,
      );
      const body = res.body as { isDraft?: boolean } | null;
      return body?.isDraft !== false;
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) return false;
      throw err;
    }
  }

  /**
   * Look for the message in Sent Items by our own x-campaign-job-id header.
   * Requires Mail.ReadBasic; when it is not consented, the caller falls back to
   * the draft check alone.
   */
  async findInSentItems(
    mailbox: string,
    jobId: string,
  ): Promise<{ found: boolean; messageId?: string; internetMessageId?: string }> {
    const encoded = encodeURIComponent(mailbox);
    const res = await this.request(
      'GET',
      `/users/${encoded}/mailFolders/sentitems/messages` +
        `?$top=50&$select=id,internetMessageId,internetMessageHeaders&$orderby=sentDateTime desc`,
    );

    const body = res.body as {
      value?: Array<{
        id?: string;
        internetMessageId?: string;
        internetMessageHeaders?: Array<{ name?: string; value?: string }>;
      }>;
    } | null;

    for (const message of body?.value ?? []) {
      const match = message.internetMessageHeaders?.some(
        (h) => h.name?.toLowerCase() === JOB_ID_HEADER && h.value === jobId,
      );
      if (match) {
        return {
          found: true,
          ...(message.id ? { messageId: message.id } : {}),
          ...(message.internetMessageId ? { internetMessageId: message.internetMessageId } : {}),
        };
      }
    }
    return { found: false };
  }

  /** Confirms the credentials and the mailbox are usable, without sending. */
  async verifyMailboxAccess(mailbox: string): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.request('GET', `/users/${encodeURIComponent(mailbox)}/mailFolders/sentitems?$select=id`);
      return { ok: true, detail: 'Mailbox reachable and the app is authorized for it.' };
    } catch (err) {
      if (err instanceof GraphError) {
        return { ok: false, detail: `${err.status ?? '?'} ${err.code ?? ''} ${err.message}` };
      }
      throw err;
    }
  }
}
