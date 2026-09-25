import pg from 'pg';
import { migrate } from '../db/migrate';
import { TEST_ENV } from './env';

/**
 * Czyści schemat bazy testowej i stosuje migracje od zera — każde uruchomienie testów
 * sprawdza jednocześnie, że migracje działają na świeżej bazie.
 */
export default async function setup(): Promise<void> {
  const url = new URL(TEST_ENV.DATABASE_URL_OWNER);
  if (!url.pathname.endsWith('_test'))
    throw new Error('Testy wolno uruchamiać tylko na bazie *_test');
  const pool = new pg.Pool({ connectionString: TEST_ENV.DATABASE_URL_OWNER, max: 1 });
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await pool.query('GRANT USAGE ON SCHEMA public TO nova_app');
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
