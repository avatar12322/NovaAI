import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type pg from 'pg';
import { REPO_ROOT } from '../config';

const MIGRATIONS_DIR = resolve(REPO_ROOT, 'infra/migrations');

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

interface MigrationStatus {
  applied: number;
  pending: number;
}

async function ensureTable(client: pg.PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

/**
 * Prosty, przewidywalny runner migracji SQL (patrz docs/DECISIONS.md, D-004).
 * Każda migracja w osobnej transakcji; zmiana treści zastosowanej migracji = błąd.
 */
export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  const client = await pool.connect();
  const appliedNow: string[] = [];
  try {
    // Blokada doradcza chroni przed równoległym uruchomieniem migracji.
    await client.query('SELECT pg_advisory_lock(727001)');
    await ensureTable(client);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const m of migrations) {
      const prev = applied.get(m.name);
      if (prev) {
        if (prev !== m.checksum) {
          throw new Error(`Migracja ${m.name} została zmieniona po zastosowaniu (checksum)`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          m.name,
          m.checksum,
        ]);
        await client.query('COMMIT');
        appliedNow.push(m.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migracja ${m.name} nie powiodła się: ${(err as Error).message}`, {
          cause: err,
        });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
  return appliedNow;
}

export async function migrationStatus(
  pool: pg.Pool,
  dir = MIGRATIONS_DIR,
): Promise<MigrationStatus> {
  const migrations = await loadMigrations(dir);
  const exists = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  if (!exists.rows[0]?.exists) return { applied: 0, pending: migrations.length };
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  return {
    applied: applied.size,
    pending: migrations.filter((m) => !applied.has(m.name)).length,
  };
}
