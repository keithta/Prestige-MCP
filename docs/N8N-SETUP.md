# n8n integration

## What n8n does, and what it deliberately cannot

n8n is an **operational convenience**, not part of the send path. It:

- wakes the worker on a schedule, so a long-idle queue starts moving promptly;
- delivers alerts to wherever you read them;
- emails a daily digest.

It **cannot**, and this is enforced by the database rather than by convention:

- read contacts, campaigns, or emails;
- claim a job, mark one sent, or mark one failed;
- change the emergency stop, global sending, or production mode;
- approve, start, pause or stop a campaign;
- add or remove a suppression.

Its role, `campaign_readonly`, has SELECT on `alerts` and the rollup views, and
UPDATE on exactly one column: `alerts.notified_at`. Ten tests in
`tests/safety/n8n-boundary.test.ts` assert each of the prohibitions above.

**If every n8n workflow were deleted, sending would carry on unchanged** — the
worker polls on its own interval, and `/tick` only shortens the wait.

## Setup

### 1. Create the database role

Run once, against your database:

```sql
-- The role itself is created by migration 0017; give it a password and login.
ALTER ROLE campaign_readonly LOGIN PASSWORD '<a long random password>';
```

On Supabase, add it as a new database user with that role.

### 2. Add credentials in n8n

**Postgres** — host, database, and the `campaign_readonly` user above. Test the
connection; it should succeed but be unable to read `campaign.contacts`.

**Header Auth** (for the heartbeat) — name `Authorization`, value
`Bearer <your WORKER_TICK_TOKEN>`.

### 3. Set environment variables on the n8n instance

| Variable | Example |
|---|---|
| `CAMPAIGN_WORKER_URL` | `https://campaign-worker.up.railway.app` |
| `CAMPAIGN_ALERT_EMAIL` | `you@yourdomain.com` |

### 4. Import the workflows

From `n8n/workflows/` (in this repository, and mirrored in `keithta/n8n`):

| File | What it does |
|---|---|
| `01-worker-heartbeat.json` | Every 5 minutes, `POST /tick`. Raises `worker_unreachable` if the worker does not answer |
| `02-alert-notifier.json` | Every 5 minutes, emails unnotified alerts and stamps `notified_at` |
| `03-daily-digest.json` | Daily at 13:00 UTC, a queue-health summary |

n8n → Workflows → Import from File. Attach the credentials, then activate.

The notifier uses Gmail as an example. Swap that node for Slack, Teams, or SMS —
it touches no campaign data, so replacing it changes nothing else.

### 5. Verify the boundary yourself

In the Postgres credential's query tool, confirm both of these:

```sql
SELECT count(*) FROM campaign.alerts;    -- works
SELECT count(*) FROM campaign.contacts;  -- permission denied
```

If the second one succeeds, the credential is using the wrong role. Fix it
before activating anything.
