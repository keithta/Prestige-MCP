# Installation

## What you need

- Node.js 20 or newer (22 LTS recommended)
- A PostgreSQL database — Supabase, or any PostgreSQL 15+
- For local development and testing: PostgreSQL **server binaries** on PATH
  (`initdb`, `pg_ctl`). Docker is not required.
- A Microsoft 365 tenant with a mailbox to send from (see `GRAPH-SETUP.md`)

## Local development, start to finish

```bash
git clone https://github.com/keithta/Prestige-MCP.git
cd Prestige-MCP/campaign
npm install

# A disposable PostgreSQL cluster on port 55432. Nothing else is touched.
npm run db:up

cp .env.example .env
# Set DATABASE_URL to the value db:up printed. Everything else can wait.

npm run migrate
npm run create-owner -- you@example.com "Your Name"
```

Then, in three terminals:

```bash
npm run dev:mock-graph   # a stand-in for Microsoft Graph on :3002
npm run dev:worker       # the sending engine on :3001
npm run dev:web          # the console on :3000
```

Sign in at http://localhost:3000 and work through **Settings** first: your
organisation name, postal address, and application URL are required before any
campaign can be approved.

### Pointing the worker at the mock

In `.env`:

```
GRAPH_BASE_URL=http://127.0.0.1:3002/v1.0
GRAPH_AUTHORITY_HOST=http://127.0.0.1:3002
GRAPH_TENANT_ID=dev-tenant
GRAPH_CLIENT_ID=dev-client
GRAPH_CLIENT_SECRET=dev-secret
```

The mock accepts any credentials and records what it "sent" — inspect it at
http://127.0.0.1:3002/__control/state, and inject failures with:

```bash
curl -XPOST http://127.0.0.1:3002/__control/fault \
  -H 'content-type: application/json' \
  -d '{"fault":"throttle_429","count":2,"retryAfterSeconds":30}'
```

Available faults: `throttle_429`, `service_unavailable`, `server_error`,
`invalid_recipient`, `access_denied`, `auth_failed`, `message_too_large`,
`hang`, `send_then_hang`. The last one is the interesting one: it delivers the
message and then never answers, which is the scenario that produces duplicate
emails in systems that guess.

**The application refuses `GRAPH_BASE_URL` overrides when `NODE_ENV=production`.**

## Against Supabase

1. Resume the project if it is paused, then Settings → Database → Connection
   string (**session** pooler, port 5432, for migrations).
2. `DATABASE_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres`
3. `npm run migrate`
4. `npm run create-owner -- you@example.com "Your Name"`

The migrations create the `campaign` schema alongside anything already in
`public`. They do not touch existing tables.

For the running application, prefer the **transaction** pooler (port 6543).

## Running the tests

```bash
npm test                  # 143 unit, integration and safety tests
npm run test:concurrency  # 8 workers × 1,000 jobs, asserts zero duplicates
npm run test:e2e          # 6 browser tests through the real UI
```

`npm test` starts the local cluster and migrates it automatically. The
end-to-end tests need the web app running:

```bash
npm run build:web
bash scripts/e2e-server.sh start
npm run test:e2e
bash scripts/e2e-server.sh stop
```

If Playwright complains its browser is missing and Chromium is already present
in your image, point at it:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e
```

## First real send

In order, and not out of it:

1. `npm run verify-graph -- campaigns@yourdomain.com` — proves the credentials
   and the access policy without sending anything.
2. Settings → add the sending mailbox.
3. Settings → add **your own address** as a test recipient.
4. Build a campaign, leave it in **test mode**, approve it, start it.
5. Confirm the email arrives, and that it appears in the mailbox's Sent Items
   carrying an `x-campaign-job-id` header.
6. Only then: Settings → enable production sending, and switch the campaign to
   production mode.

Steps 5 and 6 are separate on purpose. Two deliberate switches stand between a
fresh install and an email reaching someone who did not expect it.
