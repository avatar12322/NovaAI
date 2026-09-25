import type { DevUserKey } from '@nova/contracts';
import type { Db } from './pool';

/**
 * Dwa SZTUCZNE konta testowe i jeden dom — wyłącznie dla dev/test.
 * Nie zawierają prawdziwych danych osobowych.
 */
export const DEV_USERS: Record<DevUserKey, { email: string; displayName: string }> = {
  alfa: { email: 'alfa@example.test', displayName: 'Alfa (test)' },
  beta: { email: 'beta@example.test', displayName: 'Beta (test)' },
};

export const DEV_HOUSEHOLD_NAME = 'Dom testowy';

export interface SeedResult {
  householdId: string;
  users: Record<DevUserKey, string>;
  agents: { alfa: string; beta: string; household: string };
}

export async function seedDev(db: Db, env: string): Promise<SeedResult> {
  if (env === 'production') throw new Error('Seed danych testowych jest zabroniony w produkcji');
  const client = await db.owner.connect();
  try {
    await client.query('BEGIN');
    const users = {} as Record<DevUserKey, string>;
    for (const key of Object.keys(DEV_USERS) as DevUserKey[]) {
      const u = DEV_USERS[key];
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, display_name, is_dev_fixture) VALUES ($1, $2, true)
         ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [u.email, u.displayName],
      );
      users[key] = rows[0]!.id;
    }
    let householdId: string;
    const existing = await client.query<{ household_id: string }>(
      `SELECT household_id FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1`,
      [users.alfa],
    );
    if (existing.rows[0]) {
      householdId = existing.rows[0].household_id;
    } else {
      const h = await client.query<{ id: string }>(
        'INSERT INTO households (name) VALUES ($1) RETURNING id',
        [DEV_HOUSEHOLD_NAME],
      );
      householdId = h.rows[0]!.id;
    }
    await client.query(
      `INSERT INTO memberships (household_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')
       ON CONFLICT (household_id, user_id) DO NOTHING`,
      [householdId, users.alfa, users.beta],
    );
    const agentId = async (
      kind: 'private' | 'household',
      owner: string | null,
      name: string,
      profile: string,
    ) => {
      const found = await client.query<{ id: string }>(
        `SELECT id FROM agents WHERE household_id = $1 AND kind = $2 AND owner_user_id IS NOT DISTINCT FROM $3`,
        [householdId, kind, owner],
      );
      if (found.rows[0]) return found.rows[0].id;
      const ins = await client.query<{ id: string }>(
        `INSERT INTO agents (household_id, kind, owner_user_id, name, runtime_profile)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [householdId, kind, owner, name, profile],
      );
      return ins.rows[0]!.id;
    };
    const agents = {
      alfa: await agentId('private', users.alfa, 'Asystent Alfy', 'private-alfa'),
      beta: await agentId('private', users.beta, 'Asystent Bety', 'private-beta'),
      household: await agentId('household', null, 'NovaAI', 'household'),
    };
    await client.query('COMMIT');
    return { householdId, users, agents };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
