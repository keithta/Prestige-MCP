/**
 * Operator authentication.
 *
 * Identity comes from campaign.app_profiles, with a scrypt-hashed password
 * stored alongside. Supabase Auth can front this later without changing
 * anything downstream: everything after sign-in depends only on a user id being
 * placed into request.jwt.claims, which is exactly what Supabase provides.
 *
 * The session cookie is an HMAC-signed, expiring token. It carries no
 * privileges of its own -- the role is read from the database on every request,
 * so revoking or demoting an operator takes effect immediately.
 */
import 'server-only';
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { asService } from './db';
import type { AppRole } from '@campaign/core';

const scrypt = promisify(scryptCb);

const COOKIE = 'campaign_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET ?? process.env.UNSUBSCRIBE_HMAC_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET is not set. Generate one with: openssl rand -hex 32');
  }
  return secret;
}

export interface Session {
  userId: string;
  email: string;
  role: AppRole;
  fullName: string | null;
}

// --- password hashing -------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const derived = (await scrypt(password, Buffer.from(saltHex, 'hex'), 64)) as Buffer;
  const expected = Buffer.from(hashHex, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// --- session tokens ---------------------------------------------------------

function sign(payload: string): string {
  return createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

function createToken(userId: string): string {
  const payload = `${userId}.${Date.now() + SESSION_TTL_MS}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

function verifyToken(token: string): string | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  const payload = Buffer.from(encoded, 'base64url').toString();
  const expected = sign(payload);
  if (
    expected.length !== signature.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return null;
  }

  const [userId, expiresAt] = payload.split('.');
  if (!userId || !expiresAt || Number(expiresAt) < Date.now()) return null;
  return userId;
}

// --- session lifecycle ------------------------------------------------------

export async function signIn(email: string, password: string): Promise<Session | null> {
  const profile = await asService(async (client) => {
    const { rows } = await client.query<{
      id: string; email: string; role: AppRole; full_name: string | null;
      password_hash: string | null; disabled: boolean;
    }>(
      `SELECT id, email::text AS email, role, full_name, password_hash, disabled
         FROM campaign.app_profiles WHERE email = campaign.canonical_email($1)`,
      [email],
    );
    return rows[0] ?? null;
  });

  // Hash a dummy password when the account does not exist, so a missing account
  // and a wrong password take the same amount of time.
  if (!profile?.password_hash) {
    await verifyPassword(password, 'scrypt$00$00');
    return null;
  }
  if (profile.disabled) return null;
  if (!(await verifyPassword(password, profile.password_hash))) return null;

  const store = await cookies();
  store.set(COOKIE, createToken(profile.id), {
    httpOnly: true,
    sameSite: 'lax',
    // Keyed off the scheme the app is actually served on rather than NODE_ENV:
    // a real https deployment gets Secure, while a production-mode run over
    // http://localhost (or a local Windows install) still works. Defaults to
    // Secure when APP_BASE_URL is unset.
    secure: !(process.env.APP_BASE_URL ?? '').startsWith('http://'),
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });

  return {
    userId: profile.id,
    email: profile.email,
    role: profile.role,
    fullName: profile.full_name,
  };
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;

  const userId = verifyToken(token);
  if (!userId) return null;

  // The role is re-read every request, so a demotion or a disable takes effect
  // at once rather than when the cookie happens to expire.
  return asService(async (client) => {
    const { rows } = await client.query<{
      id: string; email: string; role: AppRole; full_name: string | null; disabled: boolean;
    }>(
      `SELECT id, email::text AS email, role, full_name, disabled
         FROM campaign.app_profiles WHERE id = $1`,
      [userId],
    );
    const profile = rows[0];
    if (!profile || profile.disabled) return null;
    return {
      userId: profile.id,
      email: profile.email,
      role: profile.role,
      fullName: profile.full_name,
    };
  });
}

const RANK: Record<AppRole, number> = { viewer: 1, operator: 2, approver: 3, owner: 4 };

export function hasRole(session: Session | null, minimum: AppRole): boolean {
  if (!session) return false;
  return RANK[session.role] >= RANK[minimum];
}

/** Throws unless the caller holds at least `minimum`. Use in every mutation. */
export async function requireRole(minimum: AppRole): Promise<Session> {
  const session = await getSession();
  if (!session) throw new Error('Not signed in.');
  if (!hasRole(session, minimum)) {
    throw new Error(
      `This action requires the ${minimum} role. You are signed in as ${session.role}.`,
    );
  }
  return session;
}
