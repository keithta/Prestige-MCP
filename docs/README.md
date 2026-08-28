# Documentation

| Document | Read it when |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | You want to understand how the system decides to send an email |
| [INSTALL.md](INSTALL.md) | Setting it up, locally or against Supabase |
| [GRAPH-SETUP.md](GRAPH-SETUP.md) | Configuring Entra ID and Microsoft Graph — do this before the first send |
| [ENVIRONMENT.md](ENVIRONMENT.md) | Looking up what a variable does |
| [DEPLOY.md](DEPLOY.md) | Deploying to Railway or the Windows machine |
| [SOP.md](SOP.md) | Running campaigns day to day |
| [RECOVERY.md](RECOVERY.md) | Something went wrong |
| [SECURITY.md](SECURITY.md) | Reviewing the security posture |
| [N8N-SETUP.md](N8N-SETUP.md) | Wiring up the automation workflows |

## The shortest possible summary

Supabase holds all state and makes every decision about whether a specific email
may be sent right now. The worker asks, and either receives authorized work or
receives nothing. The console is how a human creates and approves that work. n8n
can wake the worker but can never authorize a send.

If you read one file, read `ARCHITECTURE.md`.
