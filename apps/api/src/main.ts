import { createApp } from './app';
import { loadDotEnv, parseConfig } from './config';
import { createDb } from './db/pool';
import { buildServer } from './server';
import { VERSION } from './version';

async function main(): Promise<void> {
  loadDotEnv();
  const config = parseConfig(process.env);
  const db = createDb(config.databaseUrlApp, config.databaseUrlOwner);
  const { deps, runner, deviceServerPublicKey } = createApp(config, db, { version: VERSION });
  const app = await buildServer(deps, { logger: true, deviceServerPublicKey });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await runner.stop();
    await deps.events.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  if (config.queueEnabled) {
    runner.start();
    app.log.info({ workerId: runner.workerId }, 'queue started');
  } else {
    app.log.warn('Kolejka zadań WYŁĄCZONA (NOVA_QUEUE_ENABLED=false)');
  }
  if (config.devLogin)
    app.log.warn('Logowanie testowe (dev) jest WŁĄCZONE — tylko dla środowisk dev/test');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
