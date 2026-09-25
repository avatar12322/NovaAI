import type { HealthResponse } from '@nova/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { migrationStatus } from '../db/migrate';
import type { AppDeps } from '../deps';

export const healthRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/health', async (_req, reply) => {
      let db: 'ok' | 'down' = 'ok';
      let migrations: HealthResponse['migrations'];
      try {
        await deps.db.owner.query('SELECT 1');
        migrations = await migrationStatus(deps.db.owner);
      } catch {
        db = 'down';
      }
      const body: HealthResponse = {
        status: db === 'ok' && migrations?.pending === 0 ? 'ok' : 'degraded',
        env: deps.config.env,
        version: deps.version,
        db,
        migrations,
        queue: deps.queueStatus(),
        devLogin: deps.config.devLogin,
        time: new Date().toISOString(),
      };
      return reply.status(body.status === 'ok' ? 200 : 503).send(body);
    });
  };
