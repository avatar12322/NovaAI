import { randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  CommandPayload as CommandPayloadSchema,
  ResultPayload,
  WORKER_PROTOCOL_VERSION,
  type CommandPayload,
  type DeviceCapability,
  type GrantsPayload,
} from '@nova/contracts';
import type { WebSocket } from 'ws';
import { publicKeyFromRaw, signText, verifyText } from './keys';

export class DeviceOffline extends Error {
  constructor() {
    super('Urządzenie jest offline');
  }
}
export class DeviceTimeout extends Error {
  constructor() {
    super('Urządzenie nie odpowiedziało przed terminem');
  }
}

interface Connection {
  deviceId: string;
  ownerUserId: string;
  socket: WebSocket;
  publicKey: KeyObject;
  connectedAt: number;
}

interface Pending {
  deviceId: string;
  idempotencyKey: string;
  resolve: (r: ResultPayload) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Rejestr połączeń Workerów (tylko połączenia wychodzące z urządzeń) i oczekujących poleceń.
 * Polecenia są podpisywane kluczem serwera; wyniki muszą być podpisane kluczem urządzenia.
 */
export class DeviceHub {
  private readonly conns = new Map<string, Connection>();
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly serverKey: KeyObject,
    private readonly onStatus: (
      deviceId: string,
      ownerUserId: string,
      online: boolean,
    ) => void = () => undefined,
  ) {}

  isOnline(deviceId: string): boolean {
    return this.conns.has(deviceId);
  }

  register(deviceId: string, ownerUserId: string, publicKeyRaw: Buffer, socket: WebSocket): void {
    const prev = this.conns.get(deviceId);
    if (prev && prev.socket !== socket) prev.socket.close(4409, 'zastąpione nowym połączeniem');
    this.conns.set(deviceId, {
      deviceId,
      ownerUserId,
      socket,
      publicKey: publicKeyFromRaw(publicKeyRaw),
      connectedAt: Date.now(),
    });
    this.onStatus(deviceId, ownerUserId, true);
  }

  unregister(deviceId: string, socket: WebSocket): void {
    const c = this.conns.get(deviceId);
    if (c?.socket !== socket) return;
    this.conns.delete(deviceId);
    for (const [id, p] of this.pending) {
      if (p.deviceId === deviceId) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new DeviceOffline());
      }
    }
    this.onStatus(deviceId, c.ownerUserId, false);
  }

  /** Natychmiastowe rozłączenie (odebranie dostępu) — kolejne polecenia nie zostaną wysłane. */
  disconnect(deviceId: string, code = 4403, reason = 'dostęp odebrany'): void {
    const c = this.conns.get(deviceId);
    if (!c) return;
    c.socket.close(code, reason);
    this.unregister(deviceId, c.socket);
  }

  signed(payload: object): { payload: string; sig: string } {
    const json = JSON.stringify(payload);
    return { payload: json, sig: signText(this.serverKey, json) };
  }

  pushGrants(deviceId: string, grants: GrantsPayload['grants']): void {
    const c = this.conns.get(deviceId);
    if (!c) return;
    const p: GrantsPayload = {
      v: WORKER_PROTOCOL_VERSION,
      deviceId,
      issuedAt: new Date().toISOString(),
      grants,
    };
    c.socket.send(JSON.stringify({ type: 'grants', ...this.signed(p) }));
  }

  async send(
    deviceId: string,
    cmd: {
      capability: DeviceCapability;
      params: Record<string, unknown>;
      taskId: string | null;
      idempotencyKey: string;
    },
    timeoutMs: number,
  ): Promise<ResultPayload> {
    const c = this.conns.get(deviceId);
    if (!c) throw new DeviceOffline();
    const now = Date.now();
    const payload: CommandPayload = {
      v: WORKER_PROTOCOL_VERSION,
      commandId: randomUUID(),
      deviceId,
      taskId: cmd.taskId,
      capability: cmd.capability,
      params: cmd.params,
      idempotencyKey: cmd.idempotencyKey,
      issuedAt: new Date(now).toISOString(),
      deadline: new Date(now + timeoutMs).toISOString(),
    };
    // Walidacja przed wysyłką — Worker odrzuci niezgodny payload bez odpowiedzi.
    CommandPayloadSchema.parse(payload);
    return new Promise<ResultPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(payload.commandId);
        reject(new DeviceTimeout());
      }, timeoutMs);
      this.pending.set(payload.commandId, {
        deviceId,
        idempotencyKey: cmd.idempotencyKey,
        resolve,
        reject,
        timer,
      });
      c.socket.send(JSON.stringify({ type: 'command', ...this.signed(payload) }), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(payload.commandId);
          reject(new DeviceOffline());
        }
      });
    });
  }

  /** Wynik od urządzenia: podpis urządzenia, zgodność polecenia i klucza idempotencji. */
  handleResult(
    deviceId: string,
    frame: { payload: string; sig: string },
  ): { ok: boolean; commandId?: string; reason?: string } {
    const c = this.conns.get(deviceId);
    if (!c) return { ok: false, reason: 'not_connected' };
    if (!verifyText(c.publicKey, frame.payload, frame.sig))
      return { ok: false, reason: 'bad_signature' };
    let parsed: ResultPayload;
    try {
      const r = ResultPayload.safeParse(JSON.parse(frame.payload));
      if (!r.success) return { ok: false, reason: 'bad_payload' };
      parsed = r.data;
    } catch {
      return { ok: false, reason: 'bad_json' };
    }
    const p = this.pending.get(parsed.commandId);
    if (!p || p.deviceId !== deviceId) return { ok: false, reason: 'unknown_command' };
    if (p.idempotencyKey !== parsed.idempotencyKey)
      return { ok: false, reason: 'idempotency_mismatch' };
    clearTimeout(p.timer);
    this.pending.delete(parsed.commandId);
    p.resolve(parsed);
    return { ok: true, commandId: parsed.commandId };
  }

  closeAll(): void {
    for (const c of this.conns.values()) c.socket.close(1001, 'serwer zatrzymany');
    this.conns.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new DeviceOffline());
    }
    this.pending.clear();
  }
}
