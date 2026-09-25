import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../config';
import { sha256 } from '../lib/crypto';
import { withSystemTx, type Db } from './pool';

/**
 * Operacje administracyjne wykonywane LOKALNIE z CLI (bez API) — bootstrap produkcji bez logowania testowego.
 */
export interface NewUser {
  email: string;
  displayName: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    for (const [i, u] of users.entries()) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO users (email, display_name, is_dev_fixture) VALUES ($1, $2, false) RETURNING id`,
        [u.email.toLowerCase(), u.displayName.trim()],
      );
      const id = r.rows[0]!.id;
      userIds.push(id);
      await c.query(`INSERT INTO memberships (household_id, user_id, role) VALUES ($1, $2, $3)`, [
        householdId,
        id,
        i === 0 ? 'owner' : 'member',
      ]);
      await c.query(
        `INSERT INTO agents (household_id, kind, owner_user_id, name, runtime_profile) VALUES ($1, 'private', $2, $3, $4)`,
        [householdId, id, `Asystent: ${u.displayName.trim()}`, `private-${id.slice(0, 8)}`],
      );
    }
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
  const token = randomBytes(32).toString('base64url');
  await db.owner.query(
    `INSERT INTO enrollment_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [u.rows[0].id, sha256(token), new Date(Date.now() + ttlMinutes * 60_000)],
  );
  await db.owner.query(
    `INSERT INTO audit_log (actor_kind, source, action, owner_user_id, outcome) VALUES ('system', 'system', 'admin.enrollment_link', $1, 'ok')`,
    [u.rows[0].id],
  );
  return `${config.publicUrl}/#/enroll/${token}`;
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
