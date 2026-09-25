import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../config';
import type { Db } from '../db/pool';
import { randomToken, sha256 } from '../lib/crypto';

export const SESSION_COOKIE = 'nova_sid';

export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  method: 'dev' | 'passkey';
  expiresAt: string;
  /** Dom podstawowy (MVP: jeden dom na użytkownika). */
  householdId: string | null;
  householdRole: 'owner' | 'member' | null;
  activeHouseholdIds: ReadonlySet<string>;
}

export async function createSession(
  db: Db,
  config: AppConfig,
  userId: string,
  method: 'dev' | 'passkey',
  userAgent: string | undefined,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.sessionTtlMs);
  await db.owner.query(
    `INSERT INTO auth_sessions (user_id, token_hash, method, env, expires_at, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, sha256(token), method, config.env, expiresAt, userAgent?.slice(0, 300) ?? null],
  );
  return { token, expiresAt };
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.owner.query(
    'UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [sessionId],
  );
}

/**
 * Rozwiązuje sesję z tokenu ciasteczka. Tożsamość pochodzi WYŁĄCZNIE stąd —
 * nigdy z parametrów żądania ani z odpowiedzi modelu.
 */
export async function resolveSession(
  db: Db,
  config: AppConfig,
  token: string,
): Promise<AuthContext | null> {
  if (!token || token.length > 128) return null;
  const { rows } = await db.owner.query<{
    session_id: string;
    user_id: string;
    email: string;
    display_name: string;
    method: 'dev' | 'passkey';
    env: string;
    expires_at: string;
    is_dev_fixture: boolean;
    last_seen_at: string;
  }>(
    `SELECT s.id AS session_id, s.user_id, u.email, u.display_name, s.method, s.env, s.expires_at,
            u.is_dev_fixture, s.last_seen_at
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [sha256(token)],
  );
  const s = rows[0];
  if (!s) return null;
  // Sesja z innego środowiska lub sesja dev poza dev/test jest nieważna.
  if (s.env !== config.env) return null;
  if ((s.method === 'dev' || s.is_dev_fixture) && config.env === 'production') return null;

  const memberships = await db.owner.query<{ household_id: string; role: 'owner' | 'member' }>(
    `SELECT household_id, role FROM memberships WHERE user_id = $1 AND status = 'active' ORDER BY created_at`,
    [s.user_id],
  );
  if (Date.now() - Date.parse(s.last_seen_at) > 60_000) {
    await db.owner.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [
      s.session_id,
    ]);
  }
  const primary = memberships.rows[0];
  return {
    sessionId: s.session_id,
    userId: s.user_id,
    email: s.email,
    displayName: s.display_name,
    method: s.method,
    expiresAt: s.expires_at,
    householdId: primary?.household_id ?? null,
    householdRole: primary?.role ?? null,
    activeHouseholdIds: new Set(memberships.rows.map((m) => m.household_id)),
  };
}

/** Ciasteczko sesji: HttpOnly, SameSite=Strict, Secure w produkcji. */
export function setSessionCookie(
  reply: FastifyReply,
  config: AppConfig,
  token: string,
  expires: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.secureCookies,
    path: '/',
    expires,
  });
}
