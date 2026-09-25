import { loadDotEnv, parseConfig } from '../config';
import { migrate } from './migrate';
import { createDb } from './pool';
import { seedDev } from './seed';

async function main(): Promise<void> {
  loadDotEnv();
  const cmd = process.argv[2];
  const config = parseConfig(process.env);
  const db = createDb(config.databaseUrlApp, config.databaseUrlOwner);
  try {
    if (cmd === 'migrate') {
      const applied = await migrate(db.owner);
      console.log(applied.length ? `Zastosowano: ${applied.join(', ')}` : 'Brak nowych migracji');
    } else if (cmd === 'seed') {
      await migrate(db.owner);
      const r = await seedDev(db, config.env);
      console.log(`Seed dev: dom ${r.householdId}, użytkownicy alfa/beta`);
    } else if (cmd === 'rotate-keys') {
      const { createApp } = await import('../app');
      const { deps } = createApp(config, db);
      const n = await deps.connections.rotate();
      await deps.events.stop();
      console.log(`Ponownie zaszyfrowano tokeny: ${n}`);
    } else if (cmd === 'reset-e2e') {
      // Czysta baza dla testów e2e: dozwolone wyłącznie dla baz *_e2e poza produkcją.
      const dbName = new URL(config.databaseUrlOwner).pathname.slice(1);
      if (config.env === 'production' || !dbName.endsWith('_e2e')) {
        throw new Error('reset-e2e dozwolony tylko dla baz *_e2e poza produkcją');
      }
      await db.owner.query('DROP SCHEMA IF EXISTS public CASCADE');
      await db.owner.query('CREATE SCHEMA public');
      await db.owner.query('GRANT USAGE ON SCHEMA public TO nova_app');
      await migrate(db.owner);
      await seedDev(db, config.env);
      console.log(`Zresetowano ${dbName}`);
    } else {
      console.error('Użycie: cli.ts migrate|seed|reset-e2e|rotate-keys');
      process.exitCode = 2;
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
