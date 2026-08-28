# Recovery procedures

Each of these has been rehearsed against the local test cluster except where
noted.

## The worker died mid-send

**Nothing to do.** The next worker cycle reaps expired leases:

- A job that was **claimed** but never sent goes back to the queue. Nothing left
  the building, so retrying is safe.
- A job that was **sending** goes to `needs_reconciliation`. It is never
  returned to the queue, because the message may already have been delivered.

Reconciliation then resolves it from evidence: the draft still in Drafts proves
it did not send; a Sent Items message carrying the job's `x-campaign-job-id`
proves it did.

Verify: `curl http://localhost:3001/health` — `expired_leases` should return
to 0 within one poll interval.

## A job is stuck in "Needs attention"

Reconciliation could not decide. Almost always one of:

1. **`Mail.ReadBasic` was never consented**, so Sent Items cannot be read. Grant
   it (docs/GRAPH-SETUP.md) and it resolves on the next cycle.
2. **The draft is gone from Drafts and absent from Sent Items.** Genuinely
   undecidable. Look in the mailbox yourself:
   - It is in Sent Items → the recipient got it. In the console, that job can be
     left as-is; it will not be retried.
   - It is nowhere → it did not send. Use **retry** on the job.

Never resolve one of these by guessing. Being unable to decide is a safe state;
deciding wrongly sends a duplicate.

## A campaign paused itself

Failure thresholds (10 consecutive, or 25% of the last 50) pause a campaign
rather than let it damage the mailbox's reputation.

1. Campaign page → filter **Failed** → read the "Why" column.
2. If the cause is fixed (a credential, a policy, a bad list), Resume.
3. If the content is wrong, edit it — which revokes approval and cancels the
   unsent emails — then re-approve.

## The sending mailbox paused itself

An authentication or policy failure pauses the mailbox immediately.

```bash
cd campaign
npm run verify-graph -- campaigns@yourdomain.com
```

The output names the fix. Then Settings → set the mailbox back to `active`,
which also un-parks the jobs that were waiting on it.

## Emergency stop was engaged and nobody knows why

The reason is recorded. **Audit → System controls**, find
`system.emergency_stop_engaged`, and read the reason and who engaged it. Release
it only once you know.

Nothing was lost while it was engaged: queued emails stayed queued, and no job
state was rewritten. That is why releasing it is instant.

## Emails went to the wrong people

1. **Emergency stop, immediately.** Everything halts within one poll cycle.
2. Campaign page → how many are in **Sent**. That is the real number; the rest
   have not gone.
3. **Stop** the campaign — this cancels everything unsent, permanently.
4. Audit → filter the campaign to see exactly what happened and when.
5. Suppress anyone who should not have been contacted, so no future campaign
   reaches them.

Every sent email's rendered subject and body is stored on its job row, so you
can show exactly what each person received.

## Restoring the database

**From Supabase.** Dashboard → Database → Backups. Point-in-time restore takes
the whole project back, including anything else living in it. Prefer the schema
dump below if the problem is confined to campaign data.

**From a schema dump** (`scripts/windows/backup.ps1` writes these nightly):

```bash
# Inspect before restoring
pg_restore --list campaign-20260828-020000.dump | head -50

# Restore into a scratch database first and check the counts
createdb campaign_restore_check
pg_restore --dbname=campaign_restore_check --schema=campaign campaign-20260828-020000.dump
psql campaign_restore_check -c "select count(*) from campaign.email_jobs where status='sent'"

# Then, and only then, restore for real
pg_restore --dbname="$DATABASE_URL" --schema=campaign --clean --if-exists campaign-20260828-020000.dump
```

Restore into a scratch database first, every time. A restore that turns out to
be the wrong backup is much cheaper to discover before it overwrites the live
schema.

**After any restore**, stop the worker first, restore, then start it. A worker
running against a database that changes underneath it will hold leases on rows
that no longer mean what it thinks.

## A leaked Graph credential

1. Entra → Certificates & secrets → **delete the compromised secret**. Sending
   stops immediately; the mailbox will pause itself on the next auth failure.
2. Create a new secret, update `GRAPH_CLIENT_SECRET`, restart the worker.
3. `npm run verify-graph -- <mailbox>`.
4. Settings → set the mailbox back to `active`.
5. Entra → Sign-in logs, filtered to the application, to see whether it was used
   elsewhere.

Because the app holds only `Mail.Send` scoped by an application access policy, a
leaked credential can send as your campaign mailboxes and nothing else. That is
the whole reason for the policy.

## A bad migration

Migrations are forward-only and the runner refuses to re-run an edited one.

1. Write a **new** migration that corrects the previous one.
2. Test against a fresh local cluster: `npm run db:reset && npm run migrate`.
3. Run the full suite.
4. Apply it.

Do not edit a migration that has been applied anywhere. The checksum guard will
stop you, and it is right to.

## Everything is broken and you need to stop

```sql
UPDATE campaign.system_controls SET emergency_stop = true,
       emergency_stop_reason = 'manual intervention' WHERE id;
```

That single row stops every worker, everywhere, at its next poll — no deploy, no
restart, no access to the console required. It is the last resort and it always
works.
