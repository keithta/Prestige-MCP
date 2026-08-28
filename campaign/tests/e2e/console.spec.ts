/**
 * The operator's actual journey through the interface.
 *
 * The objective is that this system can be run without touching the code, so
 * the flow is exercised through the real UI: sign in, import contacts, build a
 * campaign, hit the compliance gate, approve, start, and stop.
 */
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { execSync } from 'node:child_process';

const DB_URL = process.env.DATABASE_URL ?? 'postgresql://campaign:campaign@127.0.0.1:55432/campaign_test';
const OWNER_EMAIL = 'e2e-owner@example.com';
const OWNER_PASSWORD = 'e2e-password-12345';

test.beforeAll(async () => {
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  try {
    await db.query(`
      TRUNCATE
        campaign.email_job_attempts, campaign.email_jobs, campaign.send_counters,
        campaign.campaign_recipients, campaign.campaign_schedules,
        campaign.campaign_content_versions, campaign.campaigns,
        campaign.contact_list_members, campaign.contact_lists,
        campaign.import_errors, campaign.import_batches, campaign.contacts,
        campaign.suppressions, campaign.test_recipients, campaign.sender_accounts,
        campaign.alerts, campaign.audit_events, campaign.app_profiles
      RESTART IDENTITY CASCADE
    `);
    await db.query(`
      UPDATE campaign.system_controls
         SET emergency_stop = false, global_send_enabled = true, production_mode = false
       WHERE id
    `);
    // Compliance settings start blank on purpose: one of the tests fills them
    // in through the UI, which is the flow a new operator actually follows.
    await db.query(
      'UPDATE campaign.compliance_settings SET org_name=NULL, postal_address=NULL, app_base_url=NULL WHERE id',
    );
  } finally {
    await db.end();
  }

  execSync(`npx tsx scripts/create-owner.ts ${OWNER_EMAIL} "E2E Owner"`, {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: DB_URL, CAMPAIGN_OWNER_PASSWORD: OWNER_PASSWORD },
  });
});

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[name="email"]', OWNER_EMAIL);
  await page.fill('input[name="password"]', OWNER_PASSWORD);
  await page.click('button[type="submit"]');
  // exact:true matters -- Playwright's default name matching is a substring,
  // and the dashboard also has an "All campaigns" link.
  await expect(page.locator('nav').getByRole('link', { name: 'Campaigns', exact: true })).toBeVisible();
});

test('the dashboard shows the system is in test mode by default', async ({ page }) => {
  await page.goto('/');
  // The safety posture must be visible without hunting for it.
  await expect(page.getByText('TEST MODE')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Emergency stop' })).toBeVisible();
});

test('the emergency stop refuses to engage without a reason and a typed phrase', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Emergency stop' }).click();

  const confirm = page.getByRole('button', { name: 'Stop everything' });
  await expect(confirm).toBeDisabled();

  await page.getByPlaceholder('Why are you stopping?').fill('e2e drill');
  await expect(confirm).toBeDisabled();

  await page.getByPlaceholder('Type STOP EVERYTHING to confirm').fill('STOP EVERYTHING');
  await expect(confirm).toBeEnabled();
});

test('settings must be configured before a campaign can be approved', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByText('Compliance details')).toBeVisible();

  await page.fill('input[name="orgName"]', 'E2E Test Org');
  await page.fill('input[name="postalAddress"]', '99 Example Road, Testville ON A1A 1A1');
  await page.fill('input[name="appBaseUrl"]', 'https://campaigns.e2e.test');
  await page
    .locator('form')
    .filter({ has: page.locator('input[name="orgName"]') })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // A sending mailbox and a test recipient.
  const senderForm = page.locator('form').filter({ has: page.locator('input[name="mailboxAddress"]') });
  await senderForm.locator('input[name="mailboxAddress"]').fill('campaigns@e2e.test');
  await senderForm.locator('input[name="tenantId"]').fill('test-tenant-id');
  await senderForm.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('campaigns@e2e.test')).toBeVisible();

  const testRecipientForm = page.locator('form').filter({ has: page.getByPlaceholder('you@example.com') });
  await testRecipientForm.getByPlaceholder('you@example.com').fill('recipient@e2e.test');
  await testRecipientForm.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('recipient@e2e.test')).toBeVisible();
});

test('contacts import shows a dry run before writing anything', async ({ page }) => {
  await page.goto('/contacts');

  const csv = [
    'email,first_name,last_name,company',
    'recipient@e2e.test,Test,Recipient,E2E Co',
    'second@e2e.test,Second,Person,E2E Co',
    'not-an-email,Broken,Row,',
    'recipient@e2e.test,Duplicate,Row,',
  ].join('\n');

  await page.setInputFiles('input[type="file"]', {
    name: 'contacts.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await page.fill('input[name="listName"]', 'E2E List');
  await page.getByRole('button', { name: 'Analyse file' }).click();
  await expect(page.getByText('Dry run — nothing has been written yet')).toBeVisible();
  await expect(page.getByText('Will import')).toBeVisible();

  await page.getByRole('button', { name: /^Import/ }).click();
  await expect(page.getByText(/Imported 2 new contact/)).toBeVisible();
});

test('a campaign cannot be approved until it is compliant, then it can be started', async ({ page }) => {
  await page.goto('/campaigns');

  await page.fill('input[name="name"]', 'E2E Campaign');
  await page.getByRole('button', { name: 'Create campaign' }).click();
  // Lands on the campaign detail page.
  await expect(page.getByRole('heading', { name: 'E2E Campaign' })).toBeVisible();

  // Content without an unsubscribe link: the gate must refuse.
  await page.fill('input[name="subject"]', 'Hello {{first_name}}');
  await page.fill('textarea[name="bodyHtml"]', '<p>Hi {{first_name|there}}, buy things.</p>');
  await page.getByRole('button', { name: 'Save content' }).click();
  await expect(page.getByText(/Content saved/)).toBeVisible();

  await expect(page.getByText(/Add \{\{unsubscribe_url\}\}/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve campaign' })).toBeDisabled();

  // Make it compliant.
  await page.fill(
    'textarea[name="bodyHtml"]',
    '<p>Hi {{first_name|there}}.</p><p><a href="{{unsubscribe_url}}">Unsubscribe</a><br>{{postal_address}}</p>',
  );
  await page.getByRole('button', { name: 'Save content' }).click();
  await expect(page.getByText(/Content saved/)).toBeVisible();

  // Audience: pick the list imported by the previous test.
  const listCheckbox = page.getByRole('checkbox').first();
  await expect(listCheckbox).toBeVisible();
  await listCheckbox.check();
  await page.getByRole('button', { name: 'Set audience' }).click();
  await expect(page.getByText('Audience saved.')).toBeVisible();

  await page.getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByText('Schedule saved.')).toBeVisible();

  // Build the emails from the approved audience.
  await page.getByRole('button', { name: 'Build emails' }).click();
  await expect(page.getByText(/Emails built/)).toBeVisible();

  await page.reload();

  // With everything in place, approval unlocks behind the typed confirmation.
  const approve = page.getByRole('button', { name: 'Approve campaign' });
  await page.getByLabel('Type APPROVE to confirm').fill('APPROVE');
  await expect(approve).toBeEnabled();
  await approve.click();

  // Once approved the builder panels give way to the monitoring view, so assert
  // on the durable state rather than the transient success message.
  await expect(page.getByRole('button', { name: 'Start sending' })).toBeVisible();
  await expect(page.locator('span').filter({ hasText: /^approved$/ }).first()).toBeVisible();

  // Starting releases the built emails into the queue. Nothing sends: the
  // default schedule is weekday business hours, and the worker is not running.
  await page.getByRole('button', { name: 'Start sending' }).click();
  await expect(page.locator('span').filter({ hasText: /^running$/ }).first()).toBeVisible();

  // Stopping asks for a typed confirmation and cancels everything unsent.
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const stopButton = page.getByRole('button', { name: 'Stop campaign' });
  await expect(stopButton).toBeDisabled();
  await page.getByPlaceholder('Type STOP to confirm').fill('STOP');
  await expect(stopButton).toBeEnabled();
  await stopButton.click();
  await expect(page.locator('span').filter({ hasText: /^stopped$/ }).first()).toBeVisible();
});

test('the audit trail records what happened', async ({ page }) => {
  await page.goto('/audit');
  await expect(page.getByText('Append-only.')).toBeVisible();
  await expect(page.getByText('campaign.approved').first()).toBeVisible();
});
