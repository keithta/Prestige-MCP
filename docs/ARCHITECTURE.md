# Architecture

## The one idea

There are two planes, and the database is the only arbiter between them.

```
CONTROL PLANE                      AUTHORITY                EXECUTION PLANE
──────────────────────────         ─────────────────        ──────────────────────────
campaign/apps/web                  Supabase Postgres        campaign/apps/worker
 · import contacts                  · all state             · poll claim_email_jobs()
 · build campaigns                  · state machine         · POST to Microsoft Graph
 · approve (content-hash lock)      · eligibility           · report the outcome
 · schedule days/hours/rate         · authorization         · renders nothing
 · monitor, pause, resume, stop     · rate counters         · decides nothing
 · emergency stop                   · suppression
 · audit                            · retry scheduling      n8n
                                    · audit (append-only)   · cron → POST /tick
                                                            · alert delivery
                                                            · NO send authority
```

**An email is never sent because something ran.** It is sent because the
database, at that instant, said this specific email is authorized. A worker that
starts for any reason — a cron misfire, an n8n webhook, a manual run, a second
process — gets zero rows back unless every check passes.

## Who owns what

| Responsibility | Owner | Deliberately not |
|---|---|---|
| Contact data | Supabase | n8n, CSV files |
| Campaign state | Supabase | UI local state |
| Email state | `campaign.email_jobs` | worker memory |
| Scheduling | SQL predicates | n8n cron, OS scheduler |
| Queue eligibility | `claim_email_jobs()` | the worker |
| **Sending authorization** | **`send_denial_reason()`** | **anything else** |
| The Graph API call | `apps/worker` only | UI, n8n |
| Retry decisions | `mark_failed()` | the worker |
| Suppression | `campaign.suppressions` | mail client rules |
| Audit history | `campaign.audit_events` | log files |

The worker reports **facts** ("I called Graph; it said X"). The database makes
**decisions** (retry, fail, suppress, pause the mailbox, pause the campaign).

## The authorization function

`campaign.send_denial_reason(job_id)` returns `NULL` when a send is authorized,
or a machine-readable reason code when it is not. It is called inside the
claiming transaction and again immediately before the Graph call. All twelve
must hold:

1. The global emergency stop is not engaged.
2. Global sending is enabled.
3. The campaign status is `running`.
4. The campaign is approved **and** the job's content hash matches the approved
   hash — so content edited after approval cannot reach anyone.
5. The job is `queued` and past its backoff gate.
6. The sending mailbox is `active` and belongs to this campaign.
7. Now is inside the campaign's allowed days and hours, in its own timezone.
8. The recipient is not suppressed (address or domain, global or campaign).
9. Hourly and daily limits are not reached, for the mailbox and the campaign.
10. The attempt budget is not exhausted.
11. Nothing else in this campaign has already gone to this address.
12. Test mode → the recipient is on the allowlist. Production mode → the global
    production switch is on.

Every refusal is recorded with its reason code, which is why the console can
always answer "why isn't this sending?".

## Preventing duplicates

Seven independent layers, each sufficient alone:

1. `UNIQUE (campaign_id, contact_id)` on `email_jobs`.
2. `idempotency_key` = `sha256(campaign ‖ contact ‖ content version)`, unique.
3. A partial unique index: at most one non-cancelled job per
   `(campaign_id, recipient_email)` — catching two contact rows that share an
   address.
4. `FOR UPDATE … SKIP LOCKED` in the claim, so two workers can never hold the
   same job. Proven by a test: 1,000 jobs, 8 concurrent workers, zero overlap.
5. **A job that was `sending` never returns to the queue.** There is no
   `sending → queued` edge in the state machine at all. An expired lease on a
   `sending` job goes to `needs_reconciliation`.
6. Every message carries `x-campaign-job-id`, and the send is a draft-create
   followed by a send. An ambiguous outcome is resolved by *evidence*: the draft
   still in Drafts proves it did not send; a Sent Items match proves it did.
7. `mark_sent` is idempotent. A second completion is a recorded no-op that
   raises a critical alert.

## Why draft-then-send

The default strategy costs two Graph calls per email:

```
POST /users/{mailbox}/messages          → draft id (persisted BEFORE sending)
POST /users/{mailbox}/messages/{id}/send → 202
```

If the second call times out, we do not know whether the message went out. With
`sendMail` there is no way to find out, so the only options are to retry (and
risk a duplicate) or to give up (and risk a silent gap). With a draft id in
hand, the question is answerable. That is the whole reason for the extra call.

Set `GRAPH_SEND_STRATEGY=send_mail` to trade that away for throughput.

## Why application permissions

The sending engine is unattended. Delegated refresh tokens expire after 90 days
of inactivity and are revoked by a password change, MFA re-registration, or a
Conditional Access change — any of which would stall a campaign overnight with
nobody present.

App-only removes that failure mode. It also grants tenant-wide `Mail.Send` by
default, which is why least privilege is restored at the Exchange layer with an
`ApplicationAccessPolicy` rather than skipped. See `GRAPH-SETUP.md`.

## Layout

```
campaign/
  apps/web/          Next.js 15 admin console (control plane)
  apps/worker/       sending engine (execution plane)
  packages/core/     types, config, rendering, retry policy, database access
  packages/graph/    the only code that talks to Microsoft Graph
  packages/testing/  mock Graph server with fault injection, fixtures
  supabase/migrations/  forward-only, numbered
  scripts/           local Postgres, migrations, owner bootstrap, Windows service
  tests/             unit, safety, concurrency, end-to-end
n8n/workflows/       heartbeat, alert notifier, daily digest
docs/                this directory
```

The repository root still holds the unrelated Prestige MCP server. It is
untouched: the campaign application lives entirely under `campaign/` with its
own workspace, so the MCP server's build and its Railway deployment are
unaffected.
