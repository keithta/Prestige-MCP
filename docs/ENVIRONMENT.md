# Environment variables

Every variable in `campaign/.env.example` appears here. A test asserts that,
so the two cannot drift apart.

`campaign/scripts/verify-env.ts` and the worker's own startup both fail fast
with an exact list of what is missing, rather than failing mid-campaign.

## Runtime

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `production` locks out Graph endpoint overrides |
| `LOG_LEVEL` | no | `info` | `trace`…`fatal` |

## Database

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | **yes** | — | TLS is required automatically for `*.supabase.co` hosts |
| `DATABASE_POOL_MAX` | no | `10` | Connections per process |

Use Supabase's **session** pooler (5432) for migrations and the **transaction**
pooler (6543) for the running application.

## Supabase (admin console)

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | no | Only if you move sign-in to Supabase Auth |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | no | Safe to expose; RLS bounds it |
| `SUPABASE_SERVICE_ROLE_KEY` | no | **Bypasses RLS.** Server-side only, never in a browser bundle |

## Microsoft Graph

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GRAPH_TENANT_ID` | **yes** | — | Directory (tenant) ID |
| `GRAPH_CLIENT_ID` | **yes** | — | Application (client) ID |
| `GRAPH_CLIENT_SECRET` | one of | — | Client secret (cloud development) |
| `GRAPH_CLIENT_CERTIFICATE_PATH` | one of | — | PEM private key (Windows production) |
| `GRAPH_CLIENT_CERTIFICATE_PASSWORD` | no | — | If the key is encrypted |
| `GRAPH_CLIENT_CERTIFICATE_THUMBPRINT` | with cert | — | From the uploaded certificate |
| `GRAPH_BASE_URL` | no | `https://graph.microsoft.com/v1.0` | **Refused in production if overridden** |
| `GRAPH_AUTHORITY_HOST` | no | `https://login.microsoftonline.com` | |
| `GRAPH_SEND_STRATEGY` | no | `draft_then_send` | `send_mail` is faster but its outcome cannot be disambiguated |
| `GRAPH_TIMEOUT_MS` | no | `30000` | A timeout is treated as an ambiguous outcome, never a retry |

Exactly one of `GRAPH_CLIENT_SECRET` or `GRAPH_CLIENT_CERTIFICATE_PATH` must be
set; startup refuses otherwise.

## Worker

| Variable | Required | Default | Notes |
|---|---|---|---|
| `WORKER_ID` | no | `worker-1` | Appears in leases, logs and the audit trail |
| `WORKER_PORT` | no | `3001` | `/health`, `/metrics`, `/tick` |
| `WORKER_POLL_INTERVAL_MS` | no | `5000` | How often to look for work |
| `WORKER_BATCH_SIZE` | no | `10` | Jobs claimed per cycle |
| `WORKER_LEASE_SECONDS` | no | `120` | Must exceed the slowest realistic send |
| `WORKER_MAX_CONCURRENCY` | no | `1` | In-flight sends per mailbox |
| `WORKER_TICK_TOKEN` | **yes** | — | Bearer token for `POST /tick`. `openssl rand -hex 32` |

## Web

| Variable | Required | Default | Notes |
|---|---|---|---|
| `WEB_PORT` | no | `3000` | |
| `APP_BASE_URL` | **yes** | `http://localhost:3000` | Also decides the session cookie's `Secure` flag: an `http://` origin turns it off so local installs work |
| `SESSION_SECRET` | **yes** | — | Signs session cookies. `openssl rand -hex 32` |
| `UNSUBSCRIBE_HMAC_SECRET` | no | — | Reserved; unsubscribe links use opaque per-job tokens, so no signing key is needed today |

## Compliance

| Variable | Required | Notes |
|---|---|---|
| `COMPLIANCE_POSTAL_ADDRESS` | see note | Seeds Settings on first run |
| `COMPLIANCE_ORG_NAME` | see note | Seeds Settings on first run |

These live in the database (Settings → Compliance details), not in the
environment, so they can be changed without a redeploy. The variables only seed
them. **A campaign cannot be approved while they are blank.**

## Never stored in the database

Microsoft Graph access tokens are held in memory only. They are never written
to Postgres or to disk, and they are redacted from logs along with every
variable named `*secret*`, `*token*`, `*password*`, and `DATABASE_URL`.

## Recipient addresses in logs

Logs contain `sha256:<12 hex>@domain`, not the address. Logs travel to places
the database does not; the full address stays in Postgres where it is
access-controlled. The domain is kept because a whole tenant bouncing is a
different problem from one bad address.
