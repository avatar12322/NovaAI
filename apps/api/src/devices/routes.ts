import websocket from '@fastify/websocket';
import {
  CreateGrantRequest,
  helloMessage,
  PairRequest,
  WORKER_PROTOCOL_VERSION,
  WorkerFrame,
  type Device,
  type PairResponse,
} from '@nova/contracts';
import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { authorize, isUuid, requireAuth } from '../access';
import { writeAudit } from '../audit';
import { withSystemTx, withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { sha256 } from '../lib/crypto';
import { conflict, forbidden, HttpError, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { normalizeCode, pairingCode, publicKeyFromRaw, verifyText } from './keys';
import { normalizePath, PathRejected } from './paths';

const PAIRING_TTL_MS = 10 * 60_000;
const HELLO_TIMEOUT_MS = 10_000;
const PING_MS = 30_000;

/**
 * Limiter NIEUDANYCH prób parowania (per IP) — ochrona przed zgadywaniem kodu (40 bitów, 10 minut).
 * Po `max` porażkach w oknie kolejne próby z tego IP są odrzucane (429) do końca okna.
 */
class FailureLimiter {
  private failures = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  private recent(key: string): number[] {
    const now = Date.now();
    const arr = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.failures.set(key, arr);
    return arr;
  }
  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }
  fail(key: string): void {
    this.recent(key).push(Date.now());
  }
}

export const deviceRoutes =
  (deps: AppDeps, serverPublicKey: Buffer): FastifyPluginAsync =>
  async (app) => {
    const limiter = new FailureLimiter(10, 60_000);
    await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

    const listDevices = (userId: string) =>
      withUserTx(deps.db, { userId, scope: 'user' }, async (c) => {
        const d = await c.query<{
          id: string;
          name: string;
          platform: string;
          status: 'active' | 'revoked';
          paired_at: string;
          last_seen_at: string | null;
        }>(
          `SELECT id, name, platform, status, paired_at, last_seen_at FROM devices
            WHERE owner_user_id = nova_uid() ORDER BY paired_at DESC`,
        );
        const g = await c.query<{
          id: string;
          device_id: string;
          capability: Device['grants'][number]['capability'];
          root: string;
          created_at: string;
        }>(
          `SELECT id, device_id, capability, root, created_at FROM device_grants
            WHERE owner_user_id = nova_uid() AND revoked_at IS NULL ORDER BY created_at`,
        );
        return d.rows.map((r): Device => ({
          id: r.id,
          name: r.name,
          platform: r.platform,
          status: r.status,
          online: deps.devices.hub.isOnline(r.id),
          pairedAt: r.paired_at,
          lastSeenAt: r.last_seen_at,
          grants: g.rows
            .filter((x) => x.device_id === r.id)
            .map((x) => ({
              id: x.id,
              capability: x.capability,
              root: x.root,
              createdAt: x.created_at,
            })),
        }));
      });

    const pushGrants = async (deviceId: string) => {
      const grants = await deps.devices.activeGrants(deviceId);
      deps.devices.hub.pushGrants(
        deviceId,
        grants.map((g) => ({ capability: g.capability, root: g.root })),
      );
    };

    app.get('/devices', async (req) => {
      const auth = requireAuth(req);
      return {
        items: await listDevices(auth.userId),
        serverPublicKey: serverPublicKey.toString('base64'),
      };
    });

    app.post('/devices/pairing-codes', async (req, reply) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      const active = await deps.db.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM device_pairing_codes WHERE owner_user_id = $1 AND used_at IS NULL AND expires_at > now()`,
        [auth.userId],
      );
      if ((active.rows[0]?.n ?? 0) >= 5)
        throw conflict('too_many_codes', 'Zbyt wiele aktywnych kodów parowania');
      const code = pairingCode();
      const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
      await deps.db.owner.query(
        `INSERT INTO device_pairing_codes (household_id, owner_user_id, code_hash, expires_at) VALUES ($1, $2, $3, $4)`,
        [auth.householdId, auth.userId, sha256(normalizeCode(code)), expiresAt],
      );
      await writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: auth.userId,
        ownerUserId: auth.userId,
        householdId: auth.householdId,
        source: 'api',
        action: 'device.pairing_code',
        outcome: 'ok',
        correlationId: req.id,
      });
      return reply.status(201).send({
        code,
        expiresAt: expiresAt.toISOString(),
        protocolVersion: WORKER_PROTOCOL_VERSION,
      });
    });

    app.post<{ Params: { id: string } }>('/devices/:id/grants', async (req, reply) => {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'device', req.params.id, 'device.manage');
      const body = parse(CreateGrantRequest, req.body);
      try {
        normalizePath(body.root);
      } catch (e) {
        throw new HttpError(
          400,
          'bad_root',
          e instanceof PathRejected ? e.message : 'Nieprawidłowy katalog',
        );
      }
      const dev = await deps.devices.device(req.params.id);
      if (dev?.status !== 'active') throw conflict('device_revoked', 'Urządzenie jest odłączone');
      const r = await deps.db.owner.query<{ id: string }>(
        `INSERT INTO device_grants (device_id, owner_user_id, capability, root) VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.params.id, auth.userId, body.capability, body.root],
      );
      await writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: auth.userId,
        ownerUserId: meta.ownerUserId,
        householdId: meta.householdId,
        source: 'api',
        action: 'device.grant',
        resourceType: 'device',
        resourceId: req.params.id,
        outcome: 'ok',
        correlationId: req.id,
        details: { capability: body.capability, root: body.root, grantId: r.rows[0]!.id },
      });
      await pushGrants(req.params.id);
      return reply.status(201).send({ id: r.rows[0]!.id });
    });

    app.delete<{ Params: { id: string; grantId: string } }>(
      '/devices/:id/grants/:grantId',
      async (req, reply) => {
        const auth = requireAuth(req);
        const meta = await authorize(deps.db, req, 'device', req.params.id, 'device.manage');
        if (!isUuid(req.params.grantId)) throw notFound('Grant');
        const r = await deps.db.owner.query(
          `UPDATE device_grants SET revoked_at = now() WHERE id = $1 AND device_id = $2 AND revoked_at IS NULL`,
          [req.params.grantId, req.params.id],
        );
        if (r.rowCount !== 1) throw notFound('Grant');
        await writeAudit(deps.db, {
          actorKind: 'user',
          actorUserId: auth.userId,
          ownerUserId: meta.ownerUserId,
          householdId: meta.householdId,
          source: 'api',
          action: 'device.grant_revoke',
          resourceType: 'device',
          resourceId: req.params.id,
          outcome: 'ok',
          correlationId: req.id,
          details: { grantId: req.params.grantId },
        });
        await pushGrants(req.params.id);
        return reply.status(204).send();
      },
    );

    /** Odłączenie urządzenia: status revoked, granty cofnięte, połączenie zamknięte NATYCHMIAST. */
    app.post<{ Params: { id: string } }>('/devices/:id/revoke', async (req) => {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'device', req.params.id, 'device.manage');
      await withSystemTx(deps.db, async (c) => {
        await c.query(
          `UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1 AND status = 'active'`,
          [req.params.id],
        );
        await c.query(
          `UPDATE device_grants SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL`,
          [req.params.id],
        );
      });
      deps.devices.hub.disconnect(req.params.id);
      await writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: auth.userId,
        ownerUserId: meta.ownerUserId,
        householdId: meta.householdId,
        source: 'api',
        action: 'device.revoke',
        resourceType: 'device',
        resourceId: req.params.id,
        outcome: 'ok',
        correlationId: req.id,
      });
      return { ok: true };
    });

    // ---------- Kanał Workera (bez sesji użytkownika; uwierzytelnienie kluczem urządzenia) ----------

    app.post('/device-link/pair', async (req, reply) => {
      if (limiter.blocked(req.ip))
        throw new HttpError(429, 'rate_limited', 'Zbyt wiele nieudanych prób parowania');
      const body = parse(PairRequest, req.body);
      if (body.protocolVersion !== WORKER_PROTOCOL_VERSION) {
        throw new HttpError(
          400,
          'protocol_version',
          `Wymagana wersja protokołu ${WORKER_PROTOCOL_VERSION}`,
        );
      }
      const pub = Buffer.from(body.publicKey, 'base64');
      try {
        publicKeyFromRaw(pub);
      } catch {
        throw new HttpError(400, 'bad_key', 'Nieprawidłowy klucz publiczny');
      }
      const result = await withSystemTx(deps.db, async (c) => {
        const code = await c.query<{ id: string; household_id: string; owner_user_id: string }>(
          `SELECT id, household_id, owner_user_id FROM device_pairing_codes
            WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
          [sha256(normalizeCode(body.code))],
        );
        const pc = code.rows[0];
        if (!pc) return null;
        const d = await c.query<{ id: string }>(
          `INSERT INTO devices (household_id, owner_user_id, name, platform, public_key) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [pc.household_id, pc.owner_user_id, body.name, body.platform, pub],
        );
        await c.query(
          `UPDATE device_pairing_codes SET used_at = now(), device_id = $2 WHERE id = $1`,
          [pc.id, d.rows[0]!.id],
        );
        return { deviceId: d.rows[0]!.id, owner: pc.owner_user_id, household: pc.household_id };
      });
      await writeAudit(deps.db, {
        actorKind: 'device',
        ownerUserId: result?.owner ?? null,
        householdId: result?.household ?? null,
        source: 'api',
        action: 'device.pair',
        resourceType: 'device',
        resourceId: result?.deviceId ?? null,
        outcome: result ? 'ok' : 'deny',
        correlationId: req.id,
        details: result ? { platform: body.platform } : { reason: 'invalid_or_expired_code' },
      });
      if (!result) {
        limiter.fail(req.ip);
        throw new HttpError(401, 'invalid_code', 'Kod parowania jest nieprawidłowy lub wygasł');
      }
      const res: PairResponse = {
        deviceId: result.deviceId,
        serverPublicKey: serverPublicKey.toString('base64'),
        protocolVersion: WORKER_PROTOCOL_VERSION,
      };
      return reply.status(201).send(res);
    });

    app.get('/device-link/connect', { websocket: true }, (socket, req) => {
      const nonce = randomBytes(32).toString('base64url');
      let deviceId: string | null = null;
      let alive = true;
      const helloTimer = setTimeout(() => {
        if (!deviceId) socket.close(4401, 'brak uwierzytelnienia');
      }, HELLO_TIMEOUT_MS);
      const ping = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
      }, PING_MS);
      socket.on('pong', () => (alive = true));
      socket.send(
        JSON.stringify({ type: 'challenge', nonce, protocolVersion: WORKER_PROTOCOL_VERSION }),
      );

      socket.on('message', (data) => {
        void (async () => {
          let frame: WorkerFrame;
          try {
            const r = WorkerFrame.safeParse(JSON.parse(data.toString()));
            if (!r.success) throw new Error('bad frame');
            frame = r.data;
          } catch {
            socket.send(
              JSON.stringify({ type: 'error', code: 'bad_frame', message: 'Nieprawidłowa ramka' }),
            );
            return;
          }
          if (frame.type === 'hello') {
            if (deviceId) return;
            const dev = await deps.devices.device(frame.deviceId);
            const valid =
              dev &&
              dev.status === 'active' &&
              frame.nonce === nonce &&
              verifyText(
                publicKeyFromRaw(dev.public_key),
                helloMessage(frame.deviceId, nonce),
                frame.sig,
              );
            await writeAudit(deps.db, {
              actorKind: 'device',
              ownerUserId: dev?.owner_user_id ?? null,
              householdId: dev?.household_id ?? null,
              source: 'worker',
              action: 'device.connect',
              resourceType: 'device',
              resourceId: frame.deviceId,
              outcome: valid ? 'ok' : 'deny',
              correlationId: req.id,
              details: { ip: req.ip, workerVersion: frame.workerVersion },
            });
            if (!valid || !dev) {
              socket.close(4401, 'uwierzytelnienie nieudane');
              return;
            }
            deviceId = dev.id;
            clearTimeout(helloTimer);
            deps.devices.hub.register(dev.id, dev.owner_user_id, dev.public_key, socket);
            await deps.db.owner.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [
              dev.id,
            ]);
            socket.send(JSON.stringify({ type: 'welcome', deviceId: dev.id }));
            await pushGrants(dev.id);
            return;
          }
          if (!deviceId) {
            socket.close(4401, 'brak uwierzytelnienia');
            return;
          }
          const r = deps.devices.hub.handleResult(deviceId, frame);
          if (r.ok) socket.send(JSON.stringify({ type: 'ack', commandId: r.commandId }));
          else
            socket.send(
              JSON.stringify({
                type: 'error',
                code: r.reason ?? 'rejected',
                message: 'Wynik odrzucony',
              }),
            );
        })().catch(() => socket.close(1011, 'błąd serwera'));
      });

      socket.on('close', () => {
        clearTimeout(helloTimer);
        clearInterval(ping);
        if (deviceId) {
          deps.devices.hub.unregister(deviceId, socket);
          void deps.db.owner
            .query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [deviceId])
            .catch(() => undefined);
        }
      });
    });
  };
