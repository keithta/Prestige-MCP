/**
 * Prove the Microsoft Graph configuration works, without sending anything.
 *
 *   npm run verify-graph -- campaigns@yourdomain.com
 *
 * Acquires an app-only token and reads the mailbox's Sent Items folder. Every
 * failure mode is translated into the thing you actually need to change.
 */
import { config } from 'dotenv';
import { loadGraphConfig, ConfigError } from '@campaign/core';
import { GraphClient, createTokenProvider } from '@campaign/graph';

config({ path: '.env', override: false });

const DIAGNOSIS: Array<[RegExp, string]> = [
  [/401|InvalidAuthenticationToken|invalid_client|unauthorized_client/,
   'The credentials were rejected. Check GRAPH_TENANT_ID, GRAPH_CLIENT_ID, and the secret or certificate.'],
  [/403|ErrorAccessDenied|Authorization_RequestDenied/,
   'Authentication worked but access to the mailbox was denied. Either admin consent for Mail.Send was never granted, or the Exchange ApplicationAccessPolicy excludes this mailbox. Run Test-ApplicationAccessPolicy for this address (docs/GRAPH-SETUP.md step 3).'],
  [/MailboxNotEnabledForRESTAPI|MailboxNotSupportedForRESTAPI/,
   'The mailbox is not reachable through Graph. It is usually on-premises, unlicensed, or a distribution list rather than a mailbox.'],
  [/404|ErrorItemNotFound|ResourceNotFound/,
   'The mailbox was not found. Check the address, and that it has an Exchange Online licence.'],
  [/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/,
   'Could not reach Microsoft. Check outbound network access to login.microsoftonline.com and graph.microsoft.com.'],
];

async function main(): Promise<void> {
  const mailbox = process.argv[2];
  if (!mailbox) {
    console.error('usage: npm run verify-graph -- campaigns@yourdomain.com');
    process.exit(2);
  }

  let graphConfig;
  try {
    graphConfig = loadGraphConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n${err.message}\n`);
      process.exit(78);
    }
    throw err;
  }

  console.log(`tenant   : ${graphConfig.GRAPH_TENANT_ID}`);
  console.log(`client   : ${graphConfig.GRAPH_CLIENT_ID}`);
  console.log(`endpoint : ${graphConfig.GRAPH_BASE_URL}`);
  console.log(`auth     : ${graphConfig.GRAPH_CLIENT_CERTIFICATE_PATH ? 'certificate' : 'client secret'}`);
  console.log(`mailbox  : ${mailbox}\n`);

  const tokens = createTokenProvider(graphConfig);

  process.stdout.write('acquiring an app-only token ... ');
  try {
    const token = await tokens.getAccessToken();
    console.log(`ok (${token.length} characters)`);
  } catch (err) {
    console.log('FAILED');
    report(err);
    process.exit(1);
  }

  process.stdout.write('reading the mailbox ... ');
  const graph = new GraphClient(graphConfig, tokens);
  const result = await graph.verifyMailboxAccess(mailbox);

  if (result.ok) {
    console.log('ok');
    console.log(`\n${result.detail}`);
    console.log('\nGraph is configured correctly. Nothing was sent.');
    console.log('Next: add this mailbox in Settings, add yourself as a test recipient,');
    console.log('and run a campaign in test mode before enabling production sending.');
    return;
  }

  console.log('FAILED');
  report(new Error(result.detail));
  process.exit(1);
}

function report(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${message}\n`);
  const hit = DIAGNOSIS.find(([pattern]) => pattern.test(message));
  console.error(hit ? `  → ${hit[1]}\n` : '  → See docs/GRAPH-SETUP.md.\n');
}

main().catch((err) => {
  report(err);
  process.exit(1);
});
