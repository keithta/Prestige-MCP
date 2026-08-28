/**
 * Resolving sends whose outcome we do not know.
 *
 * A job reaches needs_reconciliation when a request may or may not have been
 * delivered. It is NEVER retried on a guess. Instead we look for evidence:
 *
 *   1. Is the draft still in Drafts? Then it did not send. Safe to retry.
 *   2. Is a message in Sent Items carrying our x-campaign-job-id header?
 *      Then it did send. Record it and move on.
 *   3. Neither answer available -> leave it alone and alert a human.
 *
 * Step 3 is the important one. Being unable to decide is an acceptable outcome;
 * deciding wrongly is not.
 */
import {
  getJobsNeedingReconciliation,
  hashEmail,
  resolveReconciliation,
  type EmailJob,
  type Logger,
  type Pool,
} from '@campaign/core';
import { GraphError, type GraphClient } from '@campaign/graph';

export interface ReconcilerContext {
  db: Pool;
  graph: GraphClient;
  workerId: string;
  logger: Logger;
  mailboxFor(job: EmailJob): Promise<{ mailbox: string; replyTo: string | null }>;
}

export interface ReconcileSummary {
  examined: number;
  confirmedSent: number;
  confirmedNotSent: number;
  undetermined: number;
}

export async function reconcilePendingJobs(
  ctx: ReconcilerContext,
  limit = 25,
): Promise<ReconcileSummary> {
  const jobs = await getJobsNeedingReconciliation(ctx.db, limit);
  const summary: ReconcileSummary = {
    examined: jobs.length,
    confirmedSent: 0,
    confirmedNotSent: 0,
    undetermined: 0,
  };

  for (const job of jobs) {
    const log = ctx.logger.child({
      job_id: job.id,
      campaign_id: job.campaign_id,
      recipient: hashEmail(job.recipient_email),
    });

    try {
      const { mailbox } = await ctx.mailboxFor(job);

      // Evidence 1: the draft is still in Drafts, so nothing was delivered.
      if (job.graph_draft_id) {
        const stillDraft = await ctx.graph.draftStillExists(mailbox, job.graph_draft_id);
        if (stillDraft) {
          await resolveReconciliation(ctx.db, {
            jobId: job.id,
            wasSent: false,
            workerId: ctx.workerId,
            evidence: `Draft ${job.graph_draft_id} is still present in Drafts.`,
          });
          summary.confirmedNotSent += 1;
          log.info('reconciled: confirmed NOT sent (draft still in Drafts)');
          continue;
        }
      }

      // Evidence 2: our own header in Sent Items.
      const found = await ctx.graph.findInSentItems(mailbox, job.id);
      if (found.found) {
        await resolveReconciliation(ctx.db, {
          jobId: job.id,
          wasSent: true,
          workerId: ctx.workerId,
          evidence: `Found in Sent Items with x-campaign-job-id=${job.id}.`,
          graphMessageId: found.messageId ?? job.graph_draft_id,
          internetMessageId: found.internetMessageId ?? null,
        });
        summary.confirmedSent += 1;
        log.info({ graph_message_id: found.messageId }, 'reconciled: confirmed SENT');
        continue;
      }

      // A draft that has vanished from Drafts but is absent from Sent Items is
      // genuinely undecidable. Leave it for a human rather than guess.
      if (job.graph_draft_id) {
        summary.undetermined += 1;
        log.error(
          { draft_id: job.graph_draft_id },
          'reconciliation UNDETERMINED: draft is gone but no Sent Items match. Left for manual review.',
        );
        continue;
      }

      // No draft id at all (send_mail strategy) and nothing in Sent Items. The
      // absence of the header is reasonable evidence it never went out.
      await resolveReconciliation(ctx.db, {
        jobId: job.id,
        wasSent: false,
        workerId: ctx.workerId,
        evidence: 'No draft was created and no Sent Items entry carries this job id.',
      });
      summary.confirmedNotSent += 1;
      log.info('reconciled: confirmed NOT sent (absent from Sent Items)');
    } catch (err) {
      summary.undetermined += 1;
      const detail =
        err instanceof GraphError
          ? `${err.status ?? '?'} ${err.code ?? ''} ${err.message}`
          : (err as Error).message;
      // Mail.ReadBasic may simply not be consented; that is a configuration
      // problem to report, not a reason to assume anything about the send.
      log.error({ err: detail }, 'reconciliation could not complete; job left untouched');
    }
  }

  return summary;
}
