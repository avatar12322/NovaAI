import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../config';
import { sha256 } from '../lib/crypto';
import type pg from 'pg';
import { withSystemTx, type Db } from './pool';

/**
 * Operacje administracyjne wykonywane LOKALNIE z CLI (bez API) — bootstrap produkcji bez logowania testowego.
 */
interface NewUser {
  email: string;
  displayName: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Nowa osoba w domu: konto, członkostwo i prywatny asystent (w transakcji wywołującego). */
export async function addMember(
  c: pg.PoolClient,
  householdId: string,
  u: NewUser,
  role: 'owner' | 'member',
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO users (email, display_name, is_dev_fixture) VALUES ($1, $2, false) RETURNING id`,
    [u.email.toLowerCase(), u.displayName.trim()],
  );
  const id = r.rows[0]!.id;
  await c.query(`INSERT INTO memberships (household_id, user_id, role) VALUES ($1, $2, $3)`, [
    householdId,
    id,
    role,
  ]);
  await c.query(
    `INSERT INTO agents (household_id, kind, owner_user_id, name, runtime_profile) VALUES ($1, 'private', $2, $3, $4)`,
    [householdId, id, `Asystent: ${u.displayName.trim()}`, `private-${id.slice(0, 8)}`],
  );
  return id;
}

/**
 * Jednorazowy token rejestracji klucza dostępu (w bazie tylko skrót). Poprzednie niewykorzystane tokeny tej
 * osoby tracą ważność — działa tylko najnowszy link.
 */
export async function issueEnrollmentToken(
  c: Pick<pg.PoolClient, 'query'>,
  userId: string,
  ttlMs: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs);
  await c.query(
    `UPDATE enrollment_tokens SET expires_at = now() WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()`,
    [userId],
  );
  await c.query(
    `INSERT INTO enrollment_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, sha256(token), expiresAt],
  );
  return { token, expiresAt };
}

export const enrollmentLink = (config: AppConfig, token: string) =>
  `${config.publicUrl}/#/enroll/${token}`;

export async function createHousehold(
  db: Db,
  name: string,
  users: NewUser[],
): Promise<{ householdId: string; userIds: string[] }> {
  if (!name.trim()) throw new Error('Podaj nazwę domu');
  if (users.length < 1 || users.length > 8) throw new Error('Dom wymaga od 1 do 8 osób');
  for (const u of users)
    if (!EMAIL_RE.test(u.email) || !u.displayName.trim())
      throw new Error(`Nieprawidłowy użytkownik: ${u.email}`);
  return withSystemTx(db, async (c) => {
    const h = await c.query<{ id: string }>(
      'INSERT INTO households (name) VALUES ($1) RETURNING id',
      [name.trim()],
    );
    const householdId = h.rows[0]!.id;
    const userIds: string[] = [];
    for (const [i, u] of users.entries())
      userIds.push(await addMember(c, householdId, u, i === 0 ? 'owner' : 'member'));
    await c.query(
      `INSERT INTO agents (household_id, kind, owner_user_id, name, runtime_profile) VALUES ($1, 'household', NULL, 'NovaAI', 'household')`,
      [householdId],
    );
    await c.query(
      `INSERT INTO audit_log (actor_kind, source, action, household_id, outcome, details)
       VALUES ('system', 'system', 'admin.create_household', $1, 'ok', $2)`,
      [householdId, JSON.stringify({ users: users.length })],
    );
    return { householdId, userIds };
  });
}

/** Jednorazowy link do rejestracji passkey (domyślnie 15 min). W bazie wyłącznie skrót tokenu. */
export async function createEnrollmentLink(
  db: Db,
  config: AppConfig,
  email: string,
  ttlMinutes = 15,
): Promise<string> {
  const u = await db.owner.query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1 AND disabled_at IS NULL`,
    [email.toLowerCase()],
  );
  if (!u.rows[0]) throw new Error(`Brak aktywnego użytkownika ${email}`);
  if (ttlMinutes < 1 || ttlMinutes > 24 * 60) throw new Error('TTL od 1 minuty do 24 godzin');
  const { token } = await issueEnrollmentToken(db.owner, u.rows[0].id, ttlMinutes * 60_000);
  await db.owner.query(
    `INSERT INTO audit_log (actor_kind, source, action, owner_user_id, outcome) VALUES ('system', 'system', 'admin.enrollment_link', $1, 'ok')`,
    [u.rows[0].id],
  );
  return enrollmentLink(config, token);
}

/** Wyłączenie konta i unieważnienie wszystkich jego sesji. */
export async function disableUser(db: Db, email: string): Promise<void> {
  await withSystemTx(db, async (c) => {
    const r = await c.query<{ id: string }>(
      `UPDATE users SET disabled_at = now() WHERE email = $1 AND disabled_at IS NULL RETURNING id`,
      [email.toLowerCase()],
    );
    if (!r.rows[0]) throw new Error(`Brak aktywnego użytkownika ${email}`);
    await c.query(
      `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [r.rows[0].id],
    );
  });
}
