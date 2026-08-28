# Security

## Threat model

The thing this system must not do is send email it was not authorized to send —
to the wrong people, twice, or after someone said stop. Most of the design is
about that. The rest is ordinary web application hygiene.

## Microsoft Graph

- **Application permissions**, because the sender is unattended and delegated
  refresh tokens expire in ways that would stall a campaign overnight.
- **`Mail.Send` only** (plus optional `Mail.ReadBasic` for reconciliation).
  Not `Mail.ReadWrite`, not `Mail.Send.Shared`, not `Directory.*`.
- **An Exchange `ApplicationAccessPolicy`** restricts the app to a named group
  of mailboxes. Without it, app-only `Mail.Send` can send as anyone in the
  tenant. `Test-ApplicationAccessPolicy` must return `Denied` for a
  non-campaign mailbox before production sending is enabled.
- **Tokens live in memory only.** Never written to the database or to disk.
- Certificate authentication is supported and preferred on the Windows host.

## Database

Row level security is enabled on every table, and the two principals are fenced
differently:

**The console** connects as the acting user. Every query runs with
`request.jwt.claims` set, so the same policies apply as would apply to a direct
PostgREST call. There is no "the app already checked" path.

**The worker** holds the service role, so it is fenced structurally instead:

```sql
REVOKE INSERT, UPDATE, DELETE ON campaign.email_jobs FROM authenticated, anon, campaign_readonly;
```

and the nine execution-plane functions are revoked from `authenticated`. The
worker's only route to a sendable email is `claim_email_jobs()`, which
re-evaluates every authorization check inside the locking transaction.

**n8n** gets `campaign_readonly`: SELECT on alerts and the rollup views, UPDATE
on `alerts.notified_at`, and nothing else. Ten tests assert it cannot read
contacts, cannot touch `email_jobs`, cannot claim a job, cannot mark one sent,
cannot change the global controls, and cannot approve or start a campaign.

**View security is split by what each view exposes.** `job_monitor` returns
recipients and rendered bodies and runs as the *invoker*, so RLS applies row by
row. The rollups (`queue_health`, `campaign_progress`, `sender_capacity`) expose
only counts and run as the owner, so an observer can see health without being
granted the underlying tables.

**Append-only tables.** `audit_events` has UPDATE and DELETE revoked from every
role *including* the service role, plus a trigger that raises on either.
`campaign_content_versions` is immutable the same way. Suppressions are never
deleted; revocation is an audited UPDATE, and an unsubscribe or complaint cannot
be revoked at all.

## Application

- Every mutation is validated with Zod, role-checked, and audited — the audit
  write happens inside the database function so no caller can skip it.
- Campaign HTML is sanitized on save with an allowlist (`javascript:` and
  `data:` URIs blocked), and the preview renders in a **sandboxed iframe**. The
  preview runs inside an authenticated session, so unsanitized markup would be
  stored XSS against the operator.
- Merge fields are escaped by context. A contact named `<script>` is inert, and
  system fields (the unsubscribe URL, the postal address) take precedence over
  contact attributes so a CSV column cannot hijack the real link.
- A substituted value is never re-expanded, so a contact named
  `{{admin_password}}` reads nothing back out.
- Sessions are HMAC-signed, HTTP-only, `SameSite=Lax`, 12-hour cookies carrying
  no privileges of their own — the role is re-read from the database on every
  request, so a demotion or disable takes effect at once.
- Passwords are scrypt with a per-user salt. Sign-in hashes a dummy password
  when the account does not exist, so a missing account and a wrong password
  take the same time.
- Unsubscribe links carry an opaque per-job token, never an address. An invalid
  token renders exactly the same page as a valid one.
- `GRAPH_BASE_URL` cannot be overridden when `NODE_ENV=production`, so a
  misconfiguration cannot send real campaign mail to a test double.

## Secrets

| Secret | Cloud | Windows |
|---|---|---|
| `GRAPH_CLIENT_SECRET` / certificate | Railway variables | Certificate in LocalMachine store; `.env` ACL'd to the service account |
| `DATABASE_URL` | Railway variables | `.env`, ACL'd |
| `SESSION_SECRET` | Railway variables | `.env`, ACL'd |
| `WORKER_TICK_TOKEN` | Railway variables | `.env`, ACL'd |

Rotation is in `SOP.md`. Add the new credential before removing the old one,
every time.

## Logging

Recipient addresses are hashed to `sha256:<12 hex>@domain`. Logs go places the
database does not; the address stays in Postgres where it is access-controlled.
The domain is kept deliberately — a whole tenant bouncing is a different problem
from one bad address.

Redacted from logs: anything named `*secret*`, `*token*`, `*password*`,
`authorization`, and `DATABASE_URL`.

## Data retention

Each job stores the rendered subject and body it sent. That is what lets you
show exactly what a person received, and it means recipient-identifiable content
is in the database. There is no automatic purge today. If you want one, the
column to null out is `email_jobs.body_html` / `body_text` after N days; the
metadata and the audit trail can be kept indefinitely.

## Reporting

This is a private, single-tenant application. If you find a problem in it, the
audit trail (`campaign.audit_events`) is append-only and is the right place to
start reconstructing what happened.
