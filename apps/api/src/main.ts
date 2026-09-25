import { loadDotEnv, parseConfig } from './config';
import { FakeAgentRuntime } from './agent/fake-runtime';
import { createDb } from './db/pool';
import { buildServer } from './server';
import { VERSION } from './version';

async function main(): Promise<void> {
  loadDotEnv();
  const config = parseConfig(process.env);
  const db = createDb(config.databaseUrlApp, config.databaseUrlOwner);
  const app = await buildServer(
    { config, db, version: VERSION, runtime: new FakeAgentRuntime() },
    { logger: true },
  );

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  if (config.devLogin)
    app.log.warn('Logowanie testowe (dev) jest WŁĄCZONE — tylko dla środowisk dev/test');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
