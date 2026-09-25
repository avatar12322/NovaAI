import { DevLoginRequest, type DevUser, type MeResponse } from '@nova/contracts';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { requireAuth } from '../access';
import { writeAudit } from '../audit';
import { DEV_USERS } from '../db/seed';
import type { AppDeps } from '../deps';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validate';
import { createSession, revokeSession, SESSION_COOKIE, setSessionCookie } from './session';

export const authRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const setCookie = (reply: FastifyReply, token: string, expires: Date) =>
      setSessionCookie(reply, deps.config, token, expires);

    // Logowanie testowe — trasa NIE jest rejestrowana poza dev/test (patrz config.devLogin).
    if (deps.config.devLogin) {
      app.get('/auth/dev-users', async () => {
        const users: DevUser[] = (Object.keys(DEV_USERS) as Array<keyof typeof DEV_USERS>).map(
          (key) => ({
            key,
            displayName: DEV_USERS[key].displayName,
            email: DEV_USERS[key].email,
          }),
        );
        return { users, notice: 'Tryb testowy: sztuczne konta, wyłączony poza dev/test.' };
      });

      app.post('/auth/dev-login', async (req, reply) => {
        const body = parse(DevLoginRequest, req.body);
        const fixture = DEV_USERS[body.user];
        const { rows } = await deps.db.owner.query<{ id: string }>(
          'SELECT id FROM users WHERE email = $1 AND is_dev_fixture = true AND disabled_at IS NULL',
          [fixture.email],
        );
        const user = rows[0];
        if (!user)
          throw new HttpError(409, 'not_seeded', 'Brak kont testowych — uruchom pnpm db:seed');
        const { token, expiresAt } = await createSession(
          deps.db,
          deps.config,
          user.id,
          'dev',
          req.headers['user-agent'],
        );
        await writeAudit(deps.db, {
          actorKind: 'user',
          actorUserId: user.id,
          ownerUserId: user.id,
          source: 'api',
          action: 'auth.dev_login',
          outcome: 'ok',
          correlationId: req.id,
        });
        setCookie(reply, token, expiresAt);
        return { ok: true };
      });
    }

    /** Metody logowania dostępne w tym środowisku (UI nie zgaduje). */
    app.get('/auth/config', async () => ({
      devLogin: deps.config.devLogin,
      passkeys: true,
      rpId: deps.config.webauthn.rpId,
    }));

    app.post('/auth/logout', async (req, reply) => {
      if (req.auth) await revokeSession(deps.db, req.auth.sessionId);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.get('/me', async (req): Promise<MeResponse> => {
      const auth = requireAuth(req);
      let household: MeResponse['household'] = null;
      if (auth.householdId) {
        const h = await deps.db.owner.query<{ name: string }>(
          'SELECT name FROM households WHERE id = $1',
          [auth.householdId],
        );
        const members = await deps.db.owner.query<{ id: string; display_name: string }>(
          `SELECT u.id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.household_id = $1 AND m.status = 'active' ORDER BY m.created_at`,
          [auth.householdId],
        );
        household = {
          id: auth.householdId,
          name: h.rows[0]?.name ?? '',
          role: auth.householdRole ?? 'member',
          members: members.rows.map((m) => ({ id: m.id, displayName: m.display_name })),
        };
      }
      const agents = await deps.db.owner.query<{
        id: string;
        kind: 'private' | 'household';
        name: string;
      }>(
        `SELECT id, kind, name FROM agents
          WHERE household_id = ANY($1::uuid[])
            AND (kind = 'household' OR owner_user_id = $2)
          ORDER BY kind DESC, name`,
        [[...auth.activeHouseholdIds], auth.userId],
      );
      return {
        user: { id: auth.userId, email: auth.email, displayName: auth.displayName },
        household,
        agents: agents.rows,
        session: { method: auth.method, expiresAt: auth.expiresAt },
        env: deps.config.env,
      };
    });
  };
