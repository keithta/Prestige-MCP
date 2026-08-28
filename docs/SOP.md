# Operating procedures

Written to be followed without reading any code.

## Every morning

1. Open the console. If a red banner is across the top, **the emergency stop is
   engaged and nothing is sending** — go to "Something is wrong" below.
2. Check the dashboard: "Needs attention" should be 0, and there should be no
   open alerts.
3. Check "Sending capacity today" — if a mailbox is near its daily limit, a
   campaign will pause itself until tomorrow.

## Sending a campaign, start to finish

### 1. Import the contacts

**Contacts → Import contacts.** Choose the CSV, give the list a name, and record
where the list came from in "Consent note" — that field is your evidence of
consent if anyone ever asks.

Click **Analyse file** first. Nothing is written yet. You will see how many rows
will import, how many are already known, how many are duplicated within the
file, and how many are malformed, with the rejected rows listed. If those
numbers are not what you expected, **you have the wrong file** — stop here.

Then **Import**. Addresses on the suppression list are imported and flagged, not
dropped, so you can see they were on the list and will not be contacted.

### 2. Build the campaign

**Campaigns → New campaign.** Name it, choose the sending mailbox, and set "How
many contacts" if you want to send to only part of the audience. Leave it blank
to use everyone.

New campaigns are always in **test mode**.

**Content.** Merge fields are `{{first_name}}`, `{{last_name}}`, `{{company}}`,
`{{job_title}}`, `{{email}}`, plus any extra column from your CSV. Use
`{{first_name|there}}` to supply a fallback for blanks.

Two placeholders are required and approval is blocked without them:

- `{{unsubscribe_url}}` — becomes a one-click unsubscribe link
- `{{postal_address}}` — filled from Settings

The preview beside the editor is what recipients will see.

**Recipients.** Tick the lists, then **Set audience**, then **Build emails**.
Building creates one email per recipient with the content rendered and stored,
so what you approve is exactly what goes out.

**Schedule.** Days, hours, and timezone. The rate limits are per campaign; the
mailbox has its own, and the tighter of the two wins.

### 3. Approve

The checklist shows what is still missing. When it is all green, type `APPROVE`
and click Approve.

Approval locks the campaign to that exact content. **If you edit the content
afterwards, the approval is revoked and every unsent email is cancelled.** That
is deliberate: it means an approved campaign can never quietly become a
different campaign.

### 4. Send a test

While in test mode, only addresses in **Settings → Test recipients** can be
reached, at any volume. Add your own address there, start the campaign, and
confirm the email arrives and looks right.

### 5. Go to production

Two switches, both deliberate:

1. **Settings → Enable production sending** (owner only, typed confirmation).
2. Set the campaign's mode to production.

Then start it. Watch the first few minutes on the campaign page.

## Watching a campaign

The **Emails** table has a "Why" column that always has an answer. Common ones:

| What it says | What it means | What to do |
|---|---|---|
| Outside the allowed sending days or hours | Working as scheduled | Nothing; it resumes when the window opens |
| Pacing: waiting for the minimum gap | Throttle protection | Nothing |
| The mailbox's hourly send limit is reached | Working as configured | Nothing, or raise the limit in Settings |
| The recipient is on the suppression list | They unsubscribed or bounced | Nothing. Do not override this |
| The campaign is in test mode and this recipient is not on the test allowlist | Expected in test mode | Switch to production when ready |
| The campaign content changed after it was approved | Someone edited it | Re-approve the campaign |
| This campaign has already sent to this address | Duplicate blocked | Nothing — this is the protection working |

## Pause, resume, stop, emergency stop

| Control | What it does | Reversible |
|---|---|---|
| **Pause** (campaign) | That campaign stops within one poll cycle. Nothing is lost | Yes — Resume |
| **Stop** (campaign) | Cancels every unsent email in that campaign. Requires typing `STOP` | **No** |
| **Sender paused** (Settings) | That mailbox stops; other mailboxes carry on | Yes |
| **Switch off global sending** | Everything stops | Yes |
| **Emergency stop** | Everything stops immediately, and it is loud | Yes — Release |

Use **pause** for "wait a minute". Use **emergency stop** for "something is
wrong and I do not yet know what". Engaging it requires a reason, which is
recorded — write a useful one; it is what you will read later.

A send already in flight when you stop is left alone. Its outcome is still being
determined, and rewriting it would lose the record of a real send.

## Something is wrong

**A lot of failures.** The campaign pauses itself after 10 consecutive failures
or a 25% failure rate. Open the campaign, look at the "Why" column and an
attempt history, and quote the Graph request id in any Microsoft support case.

**"Needs attention" is not zero.** Those sends were handed to Graph but the
answer never came back. They are **not** retried automatically. The worker
checks Sent Items every cycle and resolves them from evidence. If a job stays
there, the mailbox may lack `Mail.ReadBasic` — see `GRAPH-SETUP.md`.

**A mailbox paused itself.** An authentication or policy failure pauses the
mailbox rather than burning the queue. Run
`npm run verify-graph -- <mailbox>` and fix what it reports, then set the
mailbox back to active in Settings.

**The worker is not sending.** In order: is the emergency stop engaged? Is
global sending on? Is the campaign running and approved? Is now inside the
sending window? Is the mailbox active and under its limits? The dashboard
answers all of these, and the campaign's "Why" column answers the rest.

**Bounce spike.** Suppress the affected domain
(Suppressions → the address, reason `domain_block`), pause the campaign, and
check the list's provenance before resuming.

## Unsubscribes

Handled automatically, and they take effect immediately — including for emails
already queued. An unsubscribe or spam complaint **can never be removed** from
the suppression list, by anyone, through the interface. That is a deliberate
limit, not an oversight.

## Rotating the Graph credential

1. Add a *new* client secret in Entra (leave the old one in place).
2. Update `GRAPH_CLIENT_SECRET` and restart the worker.
3. Confirm with `npm run verify-graph -- <mailbox>` and one test send.
4. Delete the old secret in Entra.

Never delete the old secret first. Overlapping them means a mistake costs a
restart rather than an outage.

## Escalation

| Alert | Severity | Meaning |
|---|---|---|
| `emergency_stop` | critical | Someone stopped everything. Read the reason |
| `duplicate_send.*` | critical | A duplicate was blocked. Investigate the worker |
| `needs_reconciliation.*` | critical | A send outcome is unknown |
| `sender_auth_failure.*` | critical | Credentials or access policy are wrong |
| `campaign_failure_threshold.*` | critical | A campaign paused itself |
| `worker_unreachable` | critical | The heartbeat could not reach the worker |
