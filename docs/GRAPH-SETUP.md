# Microsoft Entra ID and Graph setup

Everything here is done once, by you, in your own tenant. Nothing in this
repository can do it for you, and the application refuses to send until it is
complete.

## 1. Register the application

Entra admin centre → **Applications → App registrations → New registration**.

- Name: `Campaign Sender` (anything you like)
- Supported account types: **Accounts in this organizational directory only**
- Redirect URI: leave blank — app-only authentication uses none

Record from the Overview page:

| Value | Goes into |
|---|---|
| Directory (tenant) ID | `GRAPH_TENANT_ID` |
| Application (client) ID | `GRAPH_CLIENT_ID` |

## 2. Grant the permission

**API permissions → Add a permission → Microsoft Graph → Application
permissions**, then add:

- `Mail.Send` — required. Create a draft and send it from the campaign mailbox.
- `Mail.ReadBasic` — optional but recommended. Used *only* to look in Sent Items
  when a send's outcome is unknown. Without it, reconciliation falls back to
  checking whether the draft still exists, which is a weaker signal.

Then click **Grant admin consent**. Both permissions show "Granted for
&lt;tenant&gt;" when this is done.

Do **not** add `Mail.ReadWrite`, `Mail.Send.Shared`, `User.Read.All`, or any
`Directory.*` permission. The application does not use them.

## 3. Restrict the app to your sending mailbox — do not skip this

Application `Mail.Send` lets the app send as **any mailbox in the tenant**. An
`ApplicationAccessPolicy` is what reduces that to the mailboxes you intend.

Create a mail-enabled security group containing only your sending mailbox(es),
then, in Exchange Online PowerShell:

```powershell
Connect-ExchangeOnline

New-ApplicationAccessPolicy `
  -AppId <APPLICATION_CLIENT_ID> `
  -PolicyScopeGroupId campaign-senders@yourdomain.com `
  -AccessRight RestrictAccess `
  -Description "Restrict the campaign app to approved sending mailboxes only"
```

Verify both directions. This is the check that proves the restriction works:

```powershell
# Must return AccessCheckResult : Granted
Test-ApplicationAccessPolicy -Identity campaigns@yourdomain.com -AppId <CLIENT_ID>

# Must return AccessCheckResult : Denied
Test-ApplicationAccessPolicy -Identity someone.else@yourdomain.com -AppId <CLIENT_ID>
```

Policy changes can take up to an hour to propagate. Until the second command
returns `Denied`, do not enable production sending.

## 4. Create a credential

**Cloud development — client secret**

Certificates & secrets → New client secret → 24 months. Copy the *Value*
immediately; it is never shown again. Put it in `GRAPH_CLIENT_SECRET`.

**Windows production — certificate (recommended)**

A certificate has no secret to leak in an environment variable and the private
key can live in the machine store.

```powershell
$cert = New-SelfSignedCertificate -Subject "CN=CampaignSender" `
  -CertStoreLocation "Cert:\LocalMachine\My" -KeyExportPolicy Exportable `
  -KeySpec Signature -NotAfter (Get-Date).AddYears(2)

Export-Certificate -Cert $cert -FilePath C:\campaign\campaign-sender.cer
$cert.Thumbprint
```

Upload the `.cer` to **Certificates & secrets → Certificates**, then set
`GRAPH_CLIENT_CERTIFICATE_PATH` (to the PEM private key),
`GRAPH_CLIENT_CERTIFICATE_THUMBPRINT`, and, if the key is encrypted,
`GRAPH_CLIENT_CERTIFICATE_PASSWORD`.

## 5. Verify before sending anything

```bash
cd campaign
npm run verify-graph -- campaigns@yourdomain.com
```

This acquires a token and reads the mailbox's Sent Items folder. It sends
nothing. A failure here is diagnosable:

| Result | Meaning |
|---|---|
| `401 InvalidAuthenticationToken` | Wrong tenant, client id, or secret |
| `403 ErrorAccessDenied` | Admin consent missing, or the access policy excludes this mailbox |
| `404` | The mailbox does not exist, or has no Exchange licence |
| `MailboxNotEnabledForRESTAPI` | The mailbox is on-premises or unlicensed |

## 6. Throttling you should expect

Exchange Online enforces roughly 30 messages per minute and 10,000 recipients
per day per mailbox. The defaults here (4-second gap, 60/hour, 500/day) sit well
under both. Graph replies to throttling with `429` and a `Retry-After` header,
which the worker honours exactly rather than applying its own backoff.

## What the application does with all this

- Tokens are acquired with the client-credentials flow and **held in memory
  only**. They are never written to the database or to disk.
- Every request carries `client-request-id` set to the job's stable id, and the
  response's `request-id` is stored on the attempt. Quote it verbatim in a
  Microsoft support case.
- Every message carries an `x-campaign-job-id` internet header. That is what
  makes an ambiguous send resolvable from Sent Items instead of guessed at.
- A `401` triggers exactly one transparent token refresh and retry. A second
  `401`, or any `403`, pauses the sending mailbox and raises a critical alert
  rather than burning through the queue.
