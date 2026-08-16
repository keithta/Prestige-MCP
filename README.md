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
