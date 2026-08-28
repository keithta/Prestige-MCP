# prestige-agentic-mcp-server

An MCP (Model Context Protocol) server exposing CRUD tools over a `tasks` table
in your **Prestige Agentic** Supabase project. Deploys to Railway as a
streamable-HTTP MCP server.

## What's included

A `tasks` table was created in your Supabase project (`entebiuknprwmgigiwwj`):

| column      | type      | notes                                   |
|-------------|-----------|------------------------------------------|
| id          | uuid      | primary key, auto-generated              |
| title       | text      | required                                 |
| description | text      | optional                                 |
| status      | text      | `todo` \| `in_progress` \| `done`        |
| priority    | text      | `low` \| `medium` \| `high`              |
| due_date    | date      | optional                                 |
| created_at  | timestamptz | auto-set                               |
| updated_at  | timestamptz | auto-set on update                     |

This is a starter example — extend `src/schemas`/`src/tools` and add
migrations for your real domain tables the same way.

### Tools exposed

- `prestige_list_tasks` — filter by status/priority, paginated
- `prestige_get_task` — fetch one task by id
- `prestige_create_task` — create a task
- `prestige_update_task` — partial update
- `prestige_delete_task` — delete (destructive)

## 1. Get your Supabase service role key

The server needs the **service role key** (not the anon/publishable key) to
read and write freely, since no Row Level Security policies exist yet on
`tasks`.

1. Open the [Supabase dashboard](https://supabase.com/dashboard/project/entebiuknprwmgigiwwj/settings/api)
2. Settings → API → copy the `service_role` secret key
3. Keep it secret — it bypasses RLS entirely. Never ship it to a browser/client.

> If you'd rather use the safer anon key, add RLS policies to `tasks` first
> and swap `SUPABASE_SERVICE_ROLE_KEY` for the anon key in your env vars.

## 2. Push this code to GitHub

```bash
cd prestige-agentic-mcp-server
git init
git add .
git commit -m "Initial MCP server for Prestige Agentic tasks"
gh repo create prestige-agentic-mcp-server --private --source=. --push
# or manually: create a repo on github.com, then
# git remote add origin https://github.com/<you>/prestige-agentic-mcp-server.git
# git push -u origin main
```

## 3. Deploy to Railway

Once the repo is on GitHub, either:

**Via Railway dashboard:**
1. New Project → Deploy from GitHub repo → select `prestige-agentic-mcp-server`
2. Add environment variables (Settings → Variables):
   - `SUPABASE_URL=https://entebiuknprwmgigiwwj.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY=<the service_role key from step 1>`
   - `TRANSPORT=http`
3. Settings → Networking → Generate Domain to expose it publicly
4. Railway will run `npm run build` then `npm start` automatically (see `railway.json`)

**Or tell me once the repo is pushed** — I'm connected to your Railway
account and can create the service, set the env vars, and generate a domain
for you directly.

## 4. Connect it as an MCP server

Once deployed, your MCP endpoint is:

```
https://<your-railway-domain>/mcp
```

Add it as a custom connector in Claude (or any MCP client) pointing at that
URL. Streamable HTTP, no auth layer is included in this starter — add one
(e.g. a bearer token checked in an Express middleware) before putting
anything sensitive behind it in production.

## Local development

```bash
npm install
cp .env.example .env   # fill in your service role key
npm run dev             # http://localhost:3000/mcp
```

## Testing with MCP Inspector

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```
(For HTTP mode, point the inspector at `http://localhost:3000/mcp` instead.)

---

# Microsoft Graph email campaign application

This repository also contains a production-ready email campaign system, under
[`campaign/`](campaign/). It is entirely separate from the MCP server above:
its own workspace, its own dependencies, its own deployment. The MCP server's
build and its Railway service are unaffected.

## What it does

Import contacts, build a campaign, approve it, schedule it within allowed days
and hours, and send it through a Microsoft 365 mailbox via Microsoft Graph —
with hard guarantees that nothing is sent accidentally, without authorization,
or twice.

## The one thing worth knowing

There is a clean split between the **control plane** (where campaigns are
created and approved) and the **execution plane** (which submits already
authorized emails to Graph), and **the database is the only arbiter between
them**.

An email is never sent because a workflow fired or a schedule elapsed. It is
sent because `campaign.send_denial_reason()` returned `NULL` for that specific
email at that specific instant, inside the same transaction that leased it. A
worker that starts for any reason gets nothing back unless every one of twelve
checks passes.

## Getting started

```bash
cd campaign
npm install
npm run db:up          # a disposable PostgreSQL cluster; Docker not required
cp .env.example .env   # set DATABASE_URL to what db:up printed
npm run migrate
npm run create-owner -- you@example.com "Your Name"
npm run dev:web        # http://localhost:3000
```

Full instructions in [docs/INSTALL.md](docs/INSTALL.md).

## Documentation

| | |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | How the system decides to send an email |
| [Installation](docs/INSTALL.md) | Local, Supabase, and the first real send |
| [Graph setup](docs/GRAPH-SETUP.md) | Entra ID, permissions, and the access policy |
| [Environment](docs/ENVIRONMENT.md) | Every variable |
| [Deployment](docs/DEPLOY.md) | Railway and the local Windows machine |
| [Operating SOP](docs/SOP.md) | Running campaigns day to day |
| [Recovery](docs/RECOVERY.md) | When something goes wrong |
| [Security](docs/SECURITY.md) | The posture, and why |
| [n8n](docs/N8N-SETUP.md) | Automation with no send authority |

## Tests

```bash
cd campaign
npm test                  # unit, integration and safety
npm run test:concurrency  # 8 workers x 1,000 jobs, asserts zero duplicates
npm run test:e2e          # the real UI in a browser
```

They run against a real PostgreSQL cluster and a stand-in Microsoft Graph server
that can inject every way Graph fails in production — including the one that
matters most: a message that is delivered while the response is lost.
