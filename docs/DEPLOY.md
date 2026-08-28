# Deployment

Two environments, one codebase. The database is shared: it is the source of
truth in both, so a campaign approved in one is visible in the other.

## Cloud development — Railway

Two services in the existing `Prestige MCP` Railway project, both building from
this repository with the **root directory set to `campaign`**. That setting is
what keeps them separate from the unrelated MCP server at the repository root,
whose own service must be left exactly as it is.

### `campaign-worker`

| Setting | Value |
|---|---|
| Root directory | `campaign` |
| Build | `npm ci && npm run build` |
| Start | `npm -w @campaign/worker run start` |
| Health check | `/health` on `$WORKER_PORT` |

Variables: `DATABASE_URL`, `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
`GRAPH_CLIENT_SECRET`, `WORKER_TICK_TOKEN`, `WORKER_ID=railway-worker-1`,
`NODE_ENV=production`.

**Run exactly one instance.** Concurrent workers are safe — `SKIP LOCKED`
guarantees they never claim the same job — but the worker takes a PostgreSQL
advisory lock at startup and a second one refuses to start rather than quietly
doubling your send rate. Set replicas to 1.

### `campaign-web`

| Setting | Value |
|---|---|
| Root directory | `campaign` |
| Build | `npm ci && npm run build:web` |
| Start | `npm -w @campaign/web run start` |

Variables: `DATABASE_URL`, `SESSION_SECRET`, `APP_BASE_URL` (the generated
Railway domain, `https://…`), `NODE_ENV=production`.

`APP_BASE_URL` matters twice: it is the origin baked into unsubscribe links, and
it decides whether the session cookie is marked `Secure`. An `https://` value
gets a Secure cookie; that is what you want in the cloud.

### Migrations

Migrations do not run automatically, on purpose — a deploy that silently
reshapes the database is not something you want to discover after the fact.

```bash
cd campaign
DATABASE_URL='<supabase session pooler url>' npm run migrate -- --status   # look first
DATABASE_URL='<supabase session pooler url>' npm run migrate
```

The runner refuses to continue if a previously applied migration's contents
have changed. Migrations are forward-only: add a new one rather than editing a
shipped one.

## Local Windows production

The database stays in Supabase, so campaign state survives the machine being
rebuilt, and the console remains reachable from anywhere you allow.

### One-time setup

1. Install Node 20+ (LTS) and [NSSM](https://nssm.cc/download) (to `C:\tools\nssm.exe`).
2. Clone to `C:\campaign`.
3. ```powershell
   cd C:\campaign\campaign
   npm ci
   npm run build
   npm run build:web
   copy .env.example .env
   notepad .env       # fill in per docs\ENVIRONMENT.md
   npm run verify-env
   npm run verify-graph -- campaigns@yourdomain.com
   ```
4. ```powershell
   cd scripts\windows
   .\install-service.ps1 -InstallPath C:\campaign
   .\health-check.ps1
   ```

`install-service.ps1` refuses to install services it knows cannot start: it runs
the configuration check first and stops if anything is missing.

### What the services do

- `Campaign-Worker` — the sending engine. Auto-start, restart on failure with a
  10-second delay and a 30-second throttle, graceful stop with a 30-second
  window so in-flight sends finish and unstarted leases are handed back.
- `Campaign-Web` — the console on port 3000.

Logs rotate at 10 MB into `C:\ProgramData\CampaignApp\logs`.

### Protecting the secrets

`.env` on the Windows box holds the Graph credential and the database password.
Restrict it to the service account:

```powershell
icacls C:\campaign\campaign\.env /inheritance:r
icacls C:\campaign\campaign\.env /grant:r "NT AUTHORITY\SYSTEM:(R)" "BUILTIN\Administrators:(F)"
```

Better still, use certificate authentication (docs/GRAPH-SETUP.md step 4) so
there is no client secret in the file at all.

### Scheduled maintenance

```powershell
# Nightly backup at 02:00
schtasks /create /tn "Campaign Backup" /tr "powershell -File C:\campaign\campaign\scripts\windows\backup.ps1" /sc daily /st 02:00 /ru SYSTEM

# Health check every 15 minutes; non-zero exit means look at it
schtasks /create /tn "Campaign Health" /tr "powershell -File C:\campaign\campaign\scripts\windows\health-check.ps1" /sc minute /mo 15 /ru SYSTEM
```

> **Not yet verified on Windows.** These scripts were written and
> structurally checked, but this repository was built on Linux and no Windows
> host was available to execute them. Run `install-service.ps1` on the target
> machine and send the output back so the steps can be confirmed or corrected.

## Deploying a change

1. `npm test && npm run test:concurrency` — both must pass.
2. Review any new migration; apply it **before** deploying code that needs it.
3. Deploy the worker. It drains gracefully: SIGTERM makes it finish what is in
   flight and release the rest, so a redeploy strands nothing.
4. Deploy the console.
5. `curl https://<worker>/health` and confirm `status` is `ok`.

Rolling back is redeploying the previous build. Migrations are additive first,
so the previous release keeps working against the newer schema.
