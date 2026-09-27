import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isUuid, requireAuth } from '../access';
import { writeAudit } from '../audit';
import { addMember, enrollmentLink, issueEnrollmentToken } from '../db/admin';
import { withSystemTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { forbidden, HttpError, notFound } from '../lib/errors';
import { parse } from '../lib/validate';

/**
 * Domownicy: konta tylko z zaproszenia. Właściciel domu zaprasza osobę (imię, e-mail) — powstaje konto
 * i jednorazowy link do rejestracji klucza dostępu, ważny 7 dni (wysyłany przez właściciela, np. SMS-em).
 * Nowy link unieważnia poprzedni (np. zgubione urządzenie). Usunięcie z domu wyłącza konto i jego sesje.
 */
const INVITE_TTL_MS = 7 * 86_400_000;
const MAX_MEMBERS = 8;

const Invite = z.object({
  email: z.email('Podaj poprawny adres e-mail').max(200),
  displayName: z.string().trim().min(1, 'Podaj imię').max(60),
});

interface MemberRow {
  id: string;
  display_name: string;
  email: string;
  role: 'owner' | 'member';
  active: boolean;
  invite_expires_at: string | null;
}

export const householdRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const member = (req: FastifyRequest) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      return { auth, householdId: auth.householdId };
    };
    const owner = (req: FastifyRequest) => {
      const m = member(req);
      if (m.auth.householdRole !== 'owner')
        throw forbidden('Domowników zaprasza i usuwa tylko właściciel domu');
      return m;
    };
    const audit = (
      req: FastifyRequest,
      m: { auth: { userId: string }; householdId: string },
      action: string,
      targetUserId: string,
    ) =>
      writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: m.auth.userId,
        ownerUserId: m.auth.userId,
        householdId: m.householdId,
        source: 'api',
        action,
        resourceType: 'user',
        resourceId: targetUserId,
        outcome: 'ok',
        correlationId: req.id,
      });
    const members = async (householdId: string) =>
      (
        await deps.db.owner.query<MemberRow>(
          `SELECT u.id, u.display_name, u.email, m.role,
                  (u.is_dev_fixture OR EXISTS (SELECT 1 FROM webauthn_credentials c WHERE c.user_id = u.id))
                    AS active,
                  (SELECT max(t.expires_at) FROM enrollment_tokens t
                    WHERE t.user_id = u.id AND t.used_at IS NULL AND t.expires_at > now()) AS invite_expires_at
             FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.household_id = $1 AND m.status = 'active' AND u.disabled_at IS NULL
            ORDER BY m.role = 'owner' DESC, m.created_at`,
          [householdId],
        )
      ).rows;

    app.get('/household/members', async (req) => {
      const m = member(req);
      const isOwner = m.auth.householdRole === 'owner';
      return {
        canManage: isOwner,
        members: (await members(m.householdId)).map((r) => ({
          id: r.id,
          displayName: r.display_name,
          // Adresy e-mail widzi właściciel (zaprasza) i sama osoba.
          email: isOwner || r.id === m.auth.userId ? r.email : null,
          role: r.role,
          status: r.active ? 'active' : 'invited',
          inviteExpiresAt: r.invite_expires_at,
          me: r.id === m.auth.userId,
        })),
      };
    });

    app.post('/household/invites', async (req, reply) => {
      const m = owner(req);
      const body = parse(Invite, req.body);
      const email = body.email.toLowerCase();
      const out = await withSystemTx(deps.db, async (c) => {
        const count = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM memberships WHERE household_id = $1 AND status = 'active'`,
          [m.householdId],
        );
        if (count.rows[0]!.n >= MAX_MEMBERS)
          throw new HttpError(409, 'household_full', `Dom może mieć najwyżej ${MAX_MEMBERS} osób`);
        const existing = await c.query<{ id: string; disabled: boolean; was_here: boolean }>(
          `SELECT u.id, u.disabled_at IS NOT NULL AS disabled,
                  EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.household_id = $2
                           AND m.status = 'revoked') AS was_here
             FROM users u WHERE u.email = $1`,
          [email, m.householdId],
        );
        const prev = existing.rows[0];
        if (prev && prev.disabled && prev.was_here) {
          // Osoba wcześniej usunięta z tego domu — przywrócenie konta (jej prywatne dane zostały).
          await c.query(`UPDATE users SET disabled_at = NULL, display_name = $2 WHERE id = $1`, [
            prev.id,
            body.displayName,
          ]);
          await c.query(
            `UPDATE memberships SET status = 'active', revoked_at = NULL WHERE user_id = $1 AND household_id = $2`,
            [prev.id, m.householdId],
          );
          const { token, expiresAt } = await issueEnrollmentToken(c, prev.id, INVITE_TTL_MS);
          return { userId: prev.id, token, expiresAt };
        }
        if (prev)
          throw new HttpError(
            409,
            'email_taken',
            'Ten adres e-mail ma już konto w NovaAI — dla osoby z Twojego domu użyj „Nowy link”',
          );
        const userId = await addMember(
          c,
          m.householdId,
          { email, displayName: body.displayName },
          'member',
        );
        const { token, expiresAt } = await issueEnrollmentToken(c, userId, INVITE_TTL_MS);
        return { userId, token, expiresAt };
      });
      await audit(req, m, 'household.invite', out.userId);
      return reply.status(201).send({
        link: enrollmentLink(deps.config, out.token),
        expiresAt: out.expiresAt.toISOString(),
        memberId: out.userId,
      });
    });

    // Nowy link rejestracyjny (zaproszenie wygasło albo osoba zgubiła urządzenie z kluczem).
    app.post<{ Params: { id: string } }>('/household/members/:id/link', async (req) => {
      const m = owner(req);
      if (!isUuid(req.params.id)) throw notFound('Domownik');
      const target = req.params.id;
      const { token, expiresAt } = await withSystemTx(deps.db, async (c) => {
        const r = await c.query(
          `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.household_id = $1 AND m.user_id = $2 AND m.status = 'active' AND u.disabled_at IS NULL`,
          [m.householdId, target],
        );
        if (!r.rowCount) throw notFound('Domownik');
        return issueEnrollmentToken(c, target, INVITE_TTL_MS);
      });
      await audit(req, m, 'household.enroll_link', target);
      return { link: enrollmentLink(deps.config, token), expiresAt: expiresAt.toISOString() };
    });

    // Usunięcie z domu: członkostwo cofnięte, konto wyłączone, sesje i niewykorzystane linki unieważnione.
    app.delete<{ Params: { id: string } }>('/household/members/:id', async (req, reply) => {
      const m = owner(req);
      if (!isUuid(req.params.id)) throw notFound('Domownik');
      const target = req.params.id;
      if (target === m.auth.userId)
        throw new HttpError(409, 'cannot_remove_self', 'Nie możesz usunąć siebie z domu');
      await withSystemTx(deps.db, async (c) => {
        const r = await c.query(
          `UPDATE memberships SET status = 'revoked', revoked_at = now()
            WHERE household_id = $1 AND user_id = $2 AND status = 'active' AND role = 'member'`,
          [m.householdId, target],
        );
        if (!r.rowCount) throw notFound('Domownik');
        await c.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [target]);
        await c.query(
          `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
          [target],
        );
        await c.query(
          `UPDATE enrollment_tokens SET expires_at = now() WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()`,
          [target],
        );
      });
      await audit(req, m, 'household.remove_member', target);
      return reply.status(204).send();
    });
  };
