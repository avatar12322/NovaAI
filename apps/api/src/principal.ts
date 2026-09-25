import type { Db } from './db/pool';

/**
 * Tożsamość, w imieniu której działa serwer (żądanie HTTP albo zadanie w kolejce).
 * Dla kolejki członkostwa są ładowane ŚWIEŻO w chwili wykonania — odebranie dostępu działa od razu.
 */
export interface Principal {
  userId: string;
  displayName: string;
  householdId: string | null;
  activeHouseholdIds: ReadonlySet<string>;
}

export async function loadPrincipal(db: Db, userId: string): Promise<Principal | null> {
  const u = await db.owner.query<{ display_name: string }>(
    'SELECT display_name FROM users WHERE id = $1 AND disabled_at IS NULL',
    [userId],
  );
  if (!u.rows[0]) return null;
  const m = await db.owner.query<{ household_id: string }>(
    `SELECT household_id FROM memberships WHERE user_id = $1 AND status = 'active' ORDER BY created_at`,
    [userId],
  );
  return {
    userId,
    displayName: u.rows[0].display_name,
    householdId: m.rows[0]?.household_id ?? null,
    activeHouseholdIds: new Set(m.rows.map((r) => r.household_id)),
  };
}
