import pg from 'pg';

export type Queryable = Pick<pg.PoolClient, 'query'>;

export interface Db {
  /** Rola nova_app — każde zapytanie w transakcji z kontekstem użytkownika (RLS). */
  app: pg.Pool;
  /** Rola nova_owner — migracje, kolejka, sesje, audyt. Nie używać do odczytu treści w imieniu użytkownika. */
  owner: pg.Pool;
  close(): Promise<void>;
}

// timestamptz -> ISO string (spójna serializacja w API).
pg.types.setTypeParser(1184, (v: string) => new Date(v).toISOString());
// int8 (bigserial) -> number (w granicach bezpiecznych dla identyfikatorów zdarzeń).
pg.types.setTypeParser(20, (v: string) => Number(v));

export function createDb(appUrl: string, ownerUrl: string): Db {
  const app = new pg.Pool({ connectionString: appUrl, max: 10, application_name: 'nova-api-app' });
  const owner = new pg.Pool({
    connectionString: ownerUrl,
    max: 5,
    application_name: 'nova-api-owner',
  });
  return {
    app,
    owner,
    async close() {
      await Promise.all([app.end(), owner.end()]);
    },
  };
}

type DbScope = 'user' | 'shared';

interface UserDbContext {
  userId: string;
  scope: DbScope;
}

/**
 * Transakcja w kontekście użytkownika. Ustawienia `nova.*` są lokalne dla transakcji
 * (set_config(..., true)), więc nie wyciekają między żądaniami współdzielącymi połączenie.
 */
export async function withUserTx<T>(
  db: Db,
  ctx: UserDbContext,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.app.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('nova.user_id', $1, true), set_config('nova.scope', $2, true)",
      [ctx.userId, ctx.scope],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function withSystemTx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.owner.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
