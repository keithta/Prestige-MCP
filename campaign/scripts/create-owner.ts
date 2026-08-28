/**
 * Create the first operator account.
 *
 *   npm run create-owner -- you@example.com "Your Name"
 *
 * Reads the password from stdin (or CAMPAIGN_OWNER_PASSWORD) so it never lands
 * in shell history. Refuses once any account exists.
 */
import { createInterface } from 'node:readline/promises';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { config } from 'dotenv';

config({ path: '.env', override: false });
const scrypt = promisify(scryptCb);

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function main(): Promise<void> {
  const [email, fullName] = process.argv.slice(2);
  if (!email) {
    console.error('usage: npm run create-owner -- you@example.com "Your Name"');
    process.exit(2);
  }

  let password = process.env.CAMPAIGN_OWNER_PASSWORD ?? '';
  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question('Password (min 12 characters): ');
    rl.close();
  }
  if (password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString,
    ssl: /supabase\.(co|com)/.test(connectionString) ? { rejectUnauthorized: true } : undefined,
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      'SELECT campaign.bootstrap_owner($1, $2, $3) AS id',
      [email, await hashPassword(password), fullName ?? null],
    );
    console.log(`Created owner ${email} (${rows[0]!.id}). Sign in at the application URL.`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
