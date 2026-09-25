import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isUuid, requireAuth } from '../access';
import { writeAudit } from '../audit';
import { withSystemTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { sha256 } from '../lib/crypto';
import { HttpError, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { createSession, setSessionCookie } from './session';

const CHALLENGE_TTL_MS = 5 * 60_000;

const AnyJson = z.record(z.string(), z.unknown());
const VerifyBody = z.object({
  challengeId: z.uuid(),
  response: AnyJson,
  name: z.string().trim().min(1).max(60).optional(),
});
const EnrollOptionsBody = z.object({ token: z.string().min(20).max(200) });
const EnrollVerifyBody = VerifyBody.extend({ token: z.string().min(20).max(200) });

const uuidBytes = (id: string) => Uint8Array.from(Buffer.from(id.replace(/-/g, ''), 'hex'));

interface CredRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  transports: string[];
}

/**
 * Passkeys (WebAuthn): rejestracja (zalogowany lub przez jednorazowy link), logowanie bez hasła.
 * Wymagana weryfikacja użytkownika (UV). Wyzwania jednorazowe, 5 minut.
 */
export const passkeyRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const rp = deps.config.webauthn;

    const saveChallenge = async (
      userId: string | null,
      purpose: 'register' | 'login',
      challenge: string,
    ) => {
      const r = await deps.db.owner.query<{ id: string }>(
        `INSERT INTO webauthn_challenges (user_id, purpose, challenge, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        [userId, purpose, challenge, new Date(Date.now() + CHALLENGE_TTL_MS)],
      );
      return r.rows[0]!.id;
    };

    /** Atomowe zużycie wyzwania (także przy nieudanej weryfikacji — brak powtórek). */
    const consumeChallenge = async (
      id: string,
      purpose: 'register' | 'login',
      userId: string | null,
    ) => {
      const r = await deps.db.owner.query<{ challenge: string }>(
        `UPDATE webauthn_challenges SET used_at = now()
          WHERE id = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
            AND user_id IS NOT DISTINCT FROM $3
          RETURNING challenge`,
        [id, purpose, userId],
      );
      if (!r.rows[0])
        throw new HttpError(400, 'challenge_invalid', 'Wyzwanie wygasło lub zostało użyte');
      return r.rows[0].challenge;
    };

    const audit = (
      req: FastifyRequest,
      userId: string | null,
      action: string,
      outcome: 'ok' | 'deny',
      details: Record<string, unknown> = {},
    ) =>
      writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: userId,
        ownerUserId: userId,
        source: 'api',
        action,
        outcome,
        correlationId: req.id,
        details,
      });

    const registrationOptions = async (userId: string) => {
      const u = await deps.db.owner.query<{ email: string; display_name: string }>(
        `SELECT email, display_name FROM users WHERE id = $1 AND disabled_at IS NULL`,
        [userId],
      );
      if (!u.rows[0]) throw notFound('User');
      const existing = await deps.db.owner.query<{ credential_id: string; transports: string[] }>(
        `SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1`,
        [userId],
      );
      const options = await generateRegistrationOptions({
        rpName: rp.rpName,
        rpID: rp.rpId,
        userName: u.rows[0].email,
        userDisplayName: u.rows[0].display_name,
        userID: uuidBytes(userId),
        attestationType: 'none',
        excludeCredentials: existing.rows.map((c) => ({
          id: c.credential_id,
          transports: c.transports,
        })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      const challengeId = await saveChallenge(userId, 'register', options.challenge);
      return { challengeId, options };
    };

    const storeCredential = async (
      userId: string,
      challenge: string,
      response: RegistrationResponseJSON,
      name?: string,
    ) => {
      const v = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origins,
        expectedRPID: rp.rpId,
        requireUserVerification: true,
      }).catch(() => ({ verified: false as const }));
      if (!v.verified)
        throw new HttpError(400, 'registration_failed', 'Rejestracja klucza nie powiodła się');
      const c = v.registrationInfo.credential;
      await deps.db.owner.query(
        `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          userId,
          c.id,
          Buffer.from(c.publicKey),
          c.counter,
          c.transports ?? [],
          v.registrationInfo.credentialDeviceType,
          v.registrationInfo.credentialBackedUp,
          name ?? 'Klucz dostępu',
        ],
      );
    };

    const startSession = async (req: FastifyRequest, reply: FastifyReply, userId: string) => {
      const { token, expiresAt } = await createSession(
        deps.db,
        deps.config,
        userId,
        'passkey',
        req.headers['user-agent'],
      );
      setSessionCookie(reply, deps.config, token, expiresAt);
    };

    // ---------- logowanie ----------
    app.post('/auth/passkeys/login/options', async () => {
      const options = await generateAuthenticationOptions({
        rpID: rp.rpId,
        userVerification: 'required',
      });
      const challengeId = await saveChallenge(null, 'login', options.challenge);
      return { challengeId, options };
    });

    app.post('/auth/passkeys/login/verify', async (req, reply) => {
      const body = parse(VerifyBody, req.body);
      const challenge = await consumeChallenge(body.challengeId, 'login', null);
      const response = body.response as unknown as AuthenticationResponseJSON;
      const cred = await deps.db.owner.query<CredRow>(
        `SELECT c.id, c.user_id, c.credential_id, c.public_key, c.counter, c.transports
           FROM webauthn_credentials c JOIN users u ON u.id = c.user_id
          WHERE c.credential_id = $1 AND u.disabled_at IS NULL`,
        [String(response.id ?? '')],
      );
      const row = cred.rows[0];
      if (!row) {
        await audit(req, null, 'auth.passkey_login', 'deny', { reason: 'unknown_credential' });
        throw new HttpError(401, 'login_failed', 'Nie rozpoznano klucza dostępu');
      }
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origins,
        expectedRPID: rp.rpId,
        credential: {
          id: row.credential_id,
          publicKey: new Uint8Array(row.public_key),
          counter: Number(row.counter),
          transports: row.transports,
        },
        requireUserVerification: true,
      }).catch(() => ({ verified: false as const, authenticationInfo: null }));
      if (!v.verified || !v.authenticationInfo) {
        await audit(req, row.user_id, 'auth.passkey_login', 'deny', {
          reason: 'verification_failed',
        });
        throw new HttpError(401, 'login_failed', 'Weryfikacja klucza nie powiodła się');
      }
      await deps.db.owner.query(
        `UPDATE webauthn_credentials SET counter = $2, last_used_at = now() WHERE id = $1`,
        [row.id, v.authenticationInfo.newCounter],
      );
      await startSession(req, reply, row.user_id);
      await audit(req, row.user_id, 'auth.passkey_login', 'ok');
      return { ok: true };
    });

    // ---------- rejestracja dodatkowego klucza (zalogowany) ----------
    app.post('/auth/passkeys/register/options', async (req) =>
      registrationOptions(requireAuth(req).userId),
    );

    app.post('/auth/passkeys/register/verify', async (req, reply) => {
      const auth = requireAuth(req);
      const body = parse(VerifyBody, req.body);
      const challenge = await consumeChallenge(body.challengeId, 'register', auth.userId);
      await storeCredential(
        auth.userId,
        challenge,
        body.response as unknown as RegistrationResponseJSON,
        body.name,
      );
      await audit(req, auth.userId, 'auth.passkey_register', 'ok');
      return reply.status(201).send({ ok: true });
    });

    app.get('/auth/passkeys', async (req) => {
      const auth = requireAuth(req);
      const r = await deps.db.owner.query<{
        id: string;
        name: string;
        created_at: string;
        last_used_at: string | null;
        backed_up: boolean;
      }>(
        `SELECT id, name, created_at, last_used_at, backed_up FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at`,
        [auth.userId],
      );
      return {
        items: r.rows.map((c) => ({
          id: c.id,
          name: c.name,
          createdAt: c.created_at,
          lastUsedAt: c.last_used_at,
          backedUp: c.backed_up,
        })),
      };
    });

    app.delete<{ Params: { id: string } }>('/auth/passkeys/:id', async (req, reply) => {
      const auth = requireAuth(req);
      if (!isUuid(req.params.id)) throw notFound('Passkey');
      const r = await deps.db.owner.query(
        `DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2`,
        [req.params.id, auth.userId],
      );
      if (r.rowCount !== 1) throw notFound('Passkey');
      await audit(req, auth.userId, 'auth.passkey_delete', 'ok');
      return reply.status(204).send();
    });

    // ---------- jednorazowy link rejestracyjny (fallback wdrożeniowy, generowany w CLI) ----------
    const tokenUser = async (token: string) => {
      const r = await deps.db.owner.query<{ user_id: string }>(
        `SELECT t.user_id FROM enrollment_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() AND u.disabled_at IS NULL`,
        [sha256(token)],
      );
      return r.rows[0]?.user_id ?? null;
    };

    app.post('/auth/enroll/options', async (req) => {
      const body = parse(EnrollOptionsBody, req.body);
      const userId = await tokenUser(body.token);
      if (!userId) {
        await audit(req, null, 'auth.enroll', 'deny', { reason: 'invalid_token' });
        throw new HttpError(
          401,
          'invalid_token',
          'Link rejestracyjny jest nieprawidłowy lub wygasł',
        );
      }
      return registrationOptions(userId);
    });

    app.post('/auth/enroll/verify', async (req, reply) => {
      const body = parse(EnrollVerifyBody, req.body);
      // Token zużywany atomowo PRZED weryfikacją — link działa dokładnie raz.
      const consumed = await withSystemTx(deps.db, async (c) => {
        const r = await c.query<{ user_id: string }>(
          `UPDATE enrollment_tokens SET used_at = now()
            WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
          [sha256(body.token)],
        );
        return r.rows[0]?.user_id ?? null;
      });
      if (!consumed)
        throw new HttpError(
          401,
          'invalid_token',
          'Link rejestracyjny jest nieprawidłowy lub wygasł',
        );
      const challenge = await consumeChallenge(body.challengeId, 'register', consumed);
      await storeCredential(
        consumed,
        challenge,
        body.response as unknown as RegistrationResponseJSON,
        body.name,
      );
      await startSession(req, reply, consumed);
      await audit(req, consumed, 'auth.enroll', 'ok');
      return reply.status(201).send({ ok: true });
    });
  };
