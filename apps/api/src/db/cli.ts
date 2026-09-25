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
    } else {
      console.error('Użycie: cli.ts migrate|seed');
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
