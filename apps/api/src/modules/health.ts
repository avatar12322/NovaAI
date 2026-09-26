import type { HealthResponse } from '@nova/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { migrationStatus } from '../db/migrate';
import { runtimeFor } from '../agent/runtime';
import type { AppDeps } from '../deps';

export const healthRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/health', async (req, reply) => {
      let db: 'ok' | 'down' = 'ok';
      let migrations: HealthResponse['migrations'];
      try {
        await deps.db.owner.query('SELECT 1');
        migrations = await migrationStatus(deps.db.owner);
      } catch {
        db = 'down';
      }
      // Zalogowany domownik widzi stan modeli swojego domu (także dostawców dodanych w aplikacji).
      const householdId = req.auth?.householdId ?? null;
      let model: HealthResponse['model'] = { mode: 'demo', providers: [] };
      try {
        const [rt, snap] = await Promise.all([
          runtimeFor(deps.runtime, householdId),
          deps.gateway.snapshot(householdId),
        ]);
        model = {
          mode: rt.mode,
          providers: snap
            .status()
            .models.filter((m) => m.available)
            .map((m) => m.key),
        };
      } catch {
        // Stan modeli niedostępny (np. baza) — health i tak raportuje db: down.
      }
      const body: HealthResponse = {
        status: db === 'ok' && migrations?.pending === 0 ? 'ok' : 'degraded',
        env: deps.config.env,
        version: deps.version,
        db,
        migrations,
        queue: deps.queueStatus(),
        model,
        devLogin: deps.config.devLogin,
        time: new Date().toISOString(),
      };
      return reply.status(body.status === 'ok' ? 200 : 503).send(body);
    });
  };
