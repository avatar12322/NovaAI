import type { DevUserKey } from '@nova/contracts';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createApp, type AppOptions } from '../app';
import { parseConfig, type AppConfig } from '../config';
import { createDb, type Db } from '../db/pool';
import { seedDev, type SeedResult } from '../db/seed';
import type { AppDeps } from '../deps';
import type { TaskRunner } from '../queue/runner';
import { buildServer } from '../server';
import { TEST_ENV } from './env';

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: AppConfig;
  seed: SeedResult;
  deps: AppDeps;
  runner: TaskRunner;
  /** Przetwarza kolejkę do opróżnienia (testy nie uruchamiają pętli w tle). */
  drain(): Promise<number>;
  close(): Promise<void>;
}

export function testConfig(over: Record<string, string> = {}): AppConfig {
  return parseConfig({ ...TEST_ENV, ...over });
}

/** Czyści dane (nie schemat) — każdy plik testów startuje z czystym stanem. */
export async function truncateAll(db: Db): Promise<void> {
  const { rows } = await db.owner.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length) {
    await db.owner.query(
      `TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  }
}

export async function createTestApp(
  over: Record<string, string> = {},
  opts: AppOptions = {},
): Promise<TestApp> {
  const config = testConfig(over);
  const db = createDb(config.databaseUrlApp, config.databaseUrlOwner);
  await truncateAll(db);
  const seed = await seedDev(db, config.env);
  const { deps, runner } = createApp(config, db, {
    version: 'test',
    demoStepMs: 2,
    retryBaseMs: 1,
    ...opts,
  });
  const app = await buildServer(deps);
  return {
    app,
    db,
    config,
    seed,
    deps,
    runner,
    drain: () => runner.drain(),
    async close() {
      await app.close();
      await runner.stop();
      await deps.events.stop();
      await db.close();
    },
  };
}

export interface Client {
  cookie: string;
  get(url: string): Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  post(url: string, payload?: unknown): Promise<{ status: number; body: any }>;
  patch(url: string, payload?: unknown): Promise<{ status: number; body: any }>;
  del(url: string): Promise<{ status: number; body: any }>;
}

export async function login(app: FastifyInstance, user: DevUserKey): Promise<Client> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/dev-login',
    headers: { 'x-nova-csrf': '1' },
    payload: { user },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const raw = res.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)!.split(';')[0]!;
  return clientFor(app, cookie);
}

export function clientFor(app: FastifyInstance, cookie: string): Client {
  const call = async (opts: InjectOptions) => {
    const res = await app.inject({
      ...opts,
      headers: { cookie, 'x-nova-csrf': '1', ...(opts.headers ?? {}) },
    });
    let body: unknown;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body: body as any, headers: res.headers };
  };
  return {
    cookie,
    get: (url) => call({ method: 'GET', url }),
    post: (url, payload) => call({ method: 'POST', url, payload: (payload ?? {}) as object }),
    patch: (url, payload) => call({ method: 'PATCH', url, payload: (payload ?? {}) as object }),
    del: (url) => call({ method: 'DELETE', url }),
  };
}
