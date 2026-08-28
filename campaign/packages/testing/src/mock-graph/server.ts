/**
 * A stand-in for Microsoft Graph.
 *
 * It implements enough of the real API to exercise the entire send path --
 * token acquisition, draft creation, sending, Sent Items lookup -- and, more
 * importantly, it can be told to FAIL in each of the specific ways Graph fails
 * in production: throttling with Retry-After, 5xx, rejected recipients, an
 * access-policy denial, and the one that matters most, a request that is
 * accepted and then never answered.
 *
 * Without this, none of the retry, backoff, or reconciliation logic could be
 * tested before a real tenant exists.
 */
import express, { type Express, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

export type FaultMode =
  | 'none'
  | 'throttle_429'          // 429 + Retry-After
  | 'service_unavailable'   // 503 + Retry-After
  | 'server_error'          // 500, no Retry-After
  | 'invalid_recipient'     // 400 ErrorInvalidRecipients
  | 'access_denied'         // 403 ErrorAccessDenied (access policy)
  | 'auth_failed'           // 401 InvalidAuthenticationToken
  | 'message_too_large'     // 413
  | 'hang'                  // accept, then never respond -> client timeout
  | 'send_then_hang';       // DELIVER the message, then hang -> the duplicate trap

/** Which operation a fault applies to. */
export type FaultTarget = 'token' | 'create' | 'send' | 'read' | 'any';

export interface MockGraphState {
  fault: FaultMode;
  /**
   * Which operation the fault hits. This matters: a draft-then-send is two
   * requests plus a token request, and a test that wants "the SEND step fails
   * after delivery" must not have its fault consumed by token acquisition.
   */
  faultTarget: FaultTarget;
  /** Apply the fault to only the first N matching requests, then behave normally. */
  faultCount: number;
  retryAfterSeconds: number;
  /** Messages the mock considers delivered, keyed by graph message id. */
  sent: Map<string, StoredMessage>;
  drafts: Map<string, StoredMessage>;
  requestLog: Array<{ method: string; path: string; clientRequestId: string | null; at: number }>;
  tokensIssued: number;
}

export interface StoredMessage {
  id: string;
  internetMessageId: string;
  mailbox: string;
  subject: string;
  toAddress: string;
  jobId: string | null;
  headers: Array<{ name: string; value: string }>;
  isDraft: boolean;
  sentAt?: number;
}

export function createMockGraphState(): MockGraphState {
  return {
    fault: 'none',
    faultTarget: 'any',
    faultCount: 0,
    retryAfterSeconds: 3,
    sent: new Map(),
    drafts: new Map(),
    requestLog: [],
    tokensIssued: 0,
  };
}

function headerValue(headers: Array<{ name?: string; value?: string }> | undefined, name: string) {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

export function createMockGraphApp(state: MockGraphState): Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.use((req, _res, next) => {
    state.requestLog.push({
      method: req.method,
      path: req.path,
      clientRequestId: (req.header('client-request-id') as string | undefined) ?? null,
      at: Date.now(),
    });
    next();
  });

  /**
   * Consume one unit of the fault budget, but only for the operation the fault
   * actually targets. Without this scoping, the token request silently eats the
   * budget and the send under test succeeds normally.
   */
  function takeFault(op: Exclude<FaultTarget, 'any'>): FaultMode {
    if (state.fault === 'none' || state.faultCount <= 0) return 'none';

    const target = state.faultTarget;
    const applies =
      target === op ||
      // 'any' covers the API operations but never token acquisition, which is
      // faulted only by an explicit target or by auth_failed.
      (target === 'any' && (op !== 'token' || state.fault === 'auth_failed'));

    if (!applies) return 'none';
    state.faultCount -= 1;
    return state.fault;
  }

  function applyFault(res: Response, fault: FaultMode): boolean {
    res.setHeader('request-id', randomUUID());
    switch (fault) {
      case 'throttle_429':
        res.setHeader('retry-after', String(state.retryAfterSeconds));
        res.status(429).json({ error: { code: 'ApplicationThrottled', message: 'Too many requests' } });
        return true;
      case 'service_unavailable':
        res.setHeader('retry-after', String(state.retryAfterSeconds));
        res.status(503).json({ error: { code: 'ServiceUnavailable', message: 'Try again later' } });
        return true;
      case 'server_error':
        res.status(500).json({ error: { code: 'InternalServerError', message: 'Something went wrong' } });
        return true;
      case 'invalid_recipient':
        res.status(400).json({ error: { code: 'ErrorInvalidRecipients', message: 'Recipient address is not valid' } });
        return true;
      case 'access_denied':
        res.status(403).json({
          error: {
            code: 'ErrorAccessDenied',
            message: 'Access to OData is disabled, or the application access policy denies this mailbox.',
          },
        });
        return true;
      case 'auth_failed':
        res.status(401).json({ error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } });
        return true;
      case 'message_too_large':
        res.status(413).json({ error: { code: 'ErrorMessageSizeExceeded', message: 'Message too large' } });
        return true;
      case 'hang':
        // Never respond. The client must time out and treat this as ambiguous.
        return true;
      default:
        return false;
    }
  }

  // --- OAuth2 token endpoint -------------------------------------------------
  app.post('/:tenant/oauth2/v2.0/token', express.urlencoded({ extended: true }), (req, res) => {
    const fault = takeFault('token');
    if (fault === 'auth_failed') {
      res.status(401).json({ error: 'invalid_client', error_description: 'Client secret is invalid' });
      return;
    }
    if (!req.body?.client_id) {
      res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' });
      return;
    }
    state.tokensIssued += 1;
    res.json({
      token_type: 'Bearer',
      expires_in: 3599,
      access_token: `mock-token-${state.tokensIssued}-${randomUUID()}`,
    });
  });

  // Everything under /v1.0 requires a bearer token, as the real API does.
  app.use('/v1.0', (req, res, next) => {
    if (!req.header('authorization')?.startsWith('Bearer ')) {
      res.status(401).json({ error: { code: 'InvalidAuthenticationToken', message: 'Missing token' } });
      return;
    }
    next();
  });

  // --- Create draft ----------------------------------------------------------
  app.post('/v1.0/users/:mailbox/messages', (req: Request, res: Response) => {
    const fault = takeFault('create');
    if (applyFault(res, fault)) return;

    const body = req.body as {
      subject?: string;
      toRecipients?: Array<{ emailAddress?: { address?: string } }>;
      internetMessageHeaders?: Array<{ name?: string; value?: string }>;
    };

    const id = `AAMkAG${randomUUID().replace(/-/g, '')}`;
    const message: StoredMessage = {
      id,
      internetMessageId: `<${randomUUID()}@mock.graph>`,
      mailbox: req.params.mailbox ?? '',
      subject: body.subject ?? '',
      toAddress: body.toRecipients?.[0]?.emailAddress?.address ?? '',
      jobId: headerValue(body.internetMessageHeaders, 'x-campaign-job-id'),
      headers: (body.internetMessageHeaders ?? []).map((h) => ({
        name: h.name ?? '', value: h.value ?? '',
      })),
      isDraft: true,
    };
    state.drafts.set(id, message);

    res.setHeader('request-id', randomUUID());
    res.status(201).json({ id, internetMessageId: message.internetMessageId, isDraft: true });
  });

  // --- Send a draft ----------------------------------------------------------
  app.post('/v1.0/users/:mailbox/messages/:id/send', (req: Request, res: Response) => {
    const fault = takeFault('send');
    const id = req.params.id ?? '';

    // The nastiest real-world case: Microsoft accepts and delivers the message,
    // then the connection dies before we hear about it. A client that retries
    // here sends the email twice.
    if (fault === 'send_then_hang') {
      const draft = state.drafts.get(id);
      if (draft) {
        state.drafts.delete(id);
        state.sent.set(id, { ...draft, isDraft: false, sentAt: Date.now() });
      }
      return; // no response, ever
    }
    if (applyFault(res, fault)) return;

    const draft = state.drafts.get(id);
    if (!draft) {
      res.status(404).json({ error: { code: 'ErrorItemNotFound', message: 'Message not found' } });
      return;
    }
    state.drafts.delete(id);
    state.sent.set(id, { ...draft, isDraft: false, sentAt: Date.now() });

    res.setHeader('request-id', randomUUID());
    res.status(202).send();
  });

  // --- One-shot sendMail -----------------------------------------------------
  app.post('/v1.0/users/:mailbox/sendMail', (req: Request, res: Response) => {
    const fault = takeFault('send');
    const body = req.body as {
      message?: {
        subject?: string;
        toRecipients?: Array<{ emailAddress?: { address?: string } }>;
        internetMessageHeaders?: Array<{ name?: string; value?: string }>;
      };
    };

    if (fault === 'send_then_hang') {
      const id = `AAMkAG${randomUUID().replace(/-/g, '')}`;
      state.sent.set(id, {
        id,
        internetMessageId: `<${randomUUID()}@mock.graph>`,
        mailbox: req.params.mailbox ?? '',
        subject: body.message?.subject ?? '',
        toAddress: body.message?.toRecipients?.[0]?.emailAddress?.address ?? '',
        jobId: headerValue(body.message?.internetMessageHeaders, 'x-campaign-job-id'),
        headers: [],
        isDraft: false,
        sentAt: Date.now(),
      });
      return;
    }
    if (applyFault(res, fault)) return;

    const id = `AAMkAG${randomUUID().replace(/-/g, '')}`;
    state.sent.set(id, {
      id,
      internetMessageId: `<${randomUUID()}@mock.graph>`,
      mailbox: req.params.mailbox ?? '',
      subject: body.message?.subject ?? '',
      toAddress: body.message?.toRecipients?.[0]?.emailAddress?.address ?? '',
      jobId: headerValue(body.message?.internetMessageHeaders, 'x-campaign-job-id'),
      headers: (body.message?.internetMessageHeaders ?? []).map((h) => ({
        name: h.name ?? '', value: h.value ?? '',
      })),
      isDraft: false,
      sentAt: Date.now(),
    });

    res.setHeader('request-id', randomUUID());
    res.status(202).send();
  });

  // --- Sent Items (reconciliation evidence) ----------------------------------
  app.get('/v1.0/users/:mailbox/mailFolders/sentitems/messages', (_req, res) => {
    res.setHeader('request-id', randomUUID());
    res.json({
      value: [...state.sent.values()]
        .sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0))
        .map((m) => ({
          id: m.id,
          internetMessageId: m.internetMessageId,
          internetMessageHeaders: m.headers,
        })),
    });
  });

  app.get('/v1.0/users/:mailbox/mailFolders/sentitems', (_req, res) => {
    res.json({ id: 'sentitems', displayName: 'Sent Items' });
  });

  // --- Fetch a message (is the draft still there?) ---------------------------
  app.get('/v1.0/users/:mailbox/messages/:id', (req, res) => {
    const id = req.params.id ?? '';
    const draft = state.drafts.get(id);
    if (draft) {
      res.json({ id, isDraft: true, internetMessageId: draft.internetMessageId });
      return;
    }
    const sent = state.sent.get(id);
    if (sent) {
      res.json({ id, isDraft: false, internetMessageId: sent.internetMessageId });
      return;
    }
    res.status(404).json({ error: { code: 'ErrorItemNotFound', message: 'Not found' } });
  });

  // --- Test control plane ----------------------------------------------------
  app.post('/__control/fault', express.json(), (req, res) => {
    const body = req.body as {
      fault?: FaultMode; count?: number; retryAfterSeconds?: number; target?: FaultTarget;
    };
    state.fault = body.fault ?? 'none';
    state.faultCount = body.count ?? (body.fault && body.fault !== 'none' ? 1 : 0);
    // Faults that model "the message went out but the answer did not" only make
    // sense on the send step.
    const defaultTarget: FaultTarget =
      state.fault === 'send_then_hang' || state.fault === 'hang' ? 'send' : 'any';
    state.faultTarget = body.target ?? defaultTarget;
    if (body.retryAfterSeconds !== undefined) state.retryAfterSeconds = body.retryAfterSeconds;
    res.json({ fault: state.fault, target: state.faultTarget, count: state.faultCount });
  });

  app.get('/__control/state', (_req, res) => {
    res.json({
      fault: state.fault,
      faultTarget: state.faultTarget,
      faultCount: state.faultCount,
      sentCount: state.sent.size,
      draftCount: state.drafts.size,
      tokensIssued: state.tokensIssued,
      requestCount: state.requestLog.length,
      sent: [...state.sent.values()].map((m) => ({
        id: m.id, toAddress: m.toAddress, subject: m.subject, jobId: m.jobId,
      })),
    });
  });

  app.post('/__control/reset', (_req, res) => {
    state.fault = 'none';
    state.faultTarget = 'any';
    state.faultCount = 0;
    state.sent.clear();
    state.drafts.clear();
    state.requestLog.length = 0;
    res.json({ ok: true });
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'mock-graph' }));

  return app;
}

export interface MockGraph {
  state: MockGraphState;
  port: number;
  baseUrl: string;
  graphBaseUrl: string;
  close(): Promise<void>;
}

export async function startMockGraph(port = 0): Promise<MockGraph> {
  const state = createMockGraphState();
  const app = createMockGraphApp(state);

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const baseUrl = `http://127.0.0.1:${actualPort}`;

  return {
    state,
    port: actualPort,
    baseUrl,
    graphBaseUrl: `${baseUrl}/v1.0`,
    close: () =>
      new Promise<void>((resolve) => {
        // Destroy keep-alive sockets so a hung request cannot block shutdown.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
