/**
 * Sending one job.
 *
 * The worker's entire job is: take an already-authorized row, hand it to Graph,
 * and report what happened. It makes no eligibility decision of its own, and it
 * renders nothing -- the content it sends was snapshotted at materialization.
 */
import {
  classifyGraphError,
  hashEmail,
  markFailed,
  markSending,
  markSent,
  type EmailJob,
  type FailureClass,
  type Logger,
  type Pool,
} from '@campaign/core';
import { AmbiguousSendError, GraphError, type GraphClient } from '@campaign/graph';

export interface SendContext {
  db: Pool;
  graph: GraphClient;
  workerId: string;
  logger: Logger;
  mailboxFor(job: EmailJob): Promise<{ mailbox: string; replyTo: string | null }>;
  unsubscribeUrlFor(job: EmailJob): string | null;
}

export type SendOutcome =
  | { kind: 'sent'; jobId: string }
  | { kind: 'refused'; jobId: string; reason: string }
  | { kind: 'failed'; jobId: string; failureClass: FailureClass; finalStatus: string }
  | { kind: 'skipped'; jobId: string; reason: string };

export async function sendOneJob(ctx: SendContext, job: EmailJob): Promise<SendOutcome> {
  const log = ctx.logger.child({
    job_id: job.id,
    campaign_id: job.campaign_id,
    recipient: hashEmail(job.recipient_email),
    attempt: job.attempt_count + 1,
    correlation_id: job.client_request_id,
  });

  // Transition claimed -> sending. This re-runs the authorization check, so an
  // emergency stop or an unsubscribe that landed since we claimed still wins.
  const sending = await markSending(ctx.db, job.id, ctx.workerId);
  if (!sending.ok) {
    log.warn({ reason_code: sending.reason_code }, 'send refused at pre-flight');
    return { kind: 'refused', jobId: job.id, reason: sending.reason_code ?? 'unknown' };
  }

  const { mailbox, replyTo } = await ctx.mailboxFor(job);

  try {
    const result = await ctx.graph.send(mailbox, {
      jobId: job.id,
      clientRequestId: job.client_request_id,
      toAddress: job.recipient_email,
      toName: job.recipient_name,
      subject: job.subject,
      bodyHtml: job.body_html,
      bodyText: job.body_text,
      unsubscribeUrl: ctx.unsubscribeUrlFor(job),
      replyTo,
    });

    const recorded = await markSent(ctx.db, {
      jobId: job.id,
      workerId: ctx.workerId,
      graphMessageId: result.graphMessageId,
      internetMessageId: result.internetMessageId,
      httpStatus: result.httpStatus,
      graphRequestId: result.requestId,
    });

    if (!recorded) {
      // The database refused because the job was already sent. That is a
      // duplicate being blocked, and it is worth shouting about.
      log.error({ graph_request_id: result.requestId }, 'duplicate send blocked by the database');
      return { kind: 'skipped', jobId: job.id, reason: 'duplicate_send_attempt_blocked' };
    }

    log.info(
      { graph_request_id: result.requestId, graph_message_id: result.graphMessageId },
      'sent',
    );
    return { kind: 'sent', jobId: job.id };
  } catch (err) {
    const failureClass: FailureClass =
      err instanceof GraphError
        ? err.failureClass
        : classifyGraphError({
            message: (err as Error).message,
            networkErrorCode: (err as NodeJS.ErrnoException).code,
          });

    const graphErr = err instanceof GraphError ? err : undefined;

    const finalStatus = await markFailed(ctx.db, {
      jobId: job.id,
      workerId: ctx.workerId,
      failureClass,
      errorCode: graphErr?.code ?? (err as NodeJS.ErrnoException).code ?? 'unknown',
      errorMessage: (err as Error).message,
      httpStatus: graphErr?.status ?? null,
      graphRequestId: graphErr?.requestId ?? null,
      retryAfterSeconds: graphErr?.retryAfterSeconds ?? null,
    });

    const logPayload = {
      failure_class: failureClass,
      http_status: graphErr?.status,
      graph_code: graphErr?.code,
      graph_request_id: graphErr?.requestId,
      retry_after: graphErr?.retryAfterSeconds,
      final_status: finalStatus,
    };

    if (err instanceof AmbiguousSendError) {
      log.error(logPayload, 'send outcome UNKNOWN; job parked for reconciliation, not retried');
    } else {
      log.warn(logPayload, 'send failed');
    }

    return { kind: 'failed', jobId: job.id, failureClass, finalStatus };
  }
}
