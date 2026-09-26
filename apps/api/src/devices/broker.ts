import {
  CommandParams,
  GRANT_FOR,
  type DeviceCapability,
  type ResultPayload,
} from '@nova/contracts';
import { decide, type ContextKind, type Decision } from '@nova/permissions';
import { writeAudit } from '../audit';
import type { Db } from '../db/pool';
import { hashParams } from '../lib/crypto';
import type { Principal } from '../principal';
import { DeviceTimeout, type DeviceHub } from './hub';
import { isWithinRoot } from './paths';

export class DeviceDenied extends Error {
  constructor(public readonly reason: string) {
    super(`Odmowa dla urządzenia: ${reason}`);
  }
}
export class DeviceCommandFailed extends Error {}

interface DeviceRow {
  id: string;
  household_id: string;
  owner_user_id: string;
  name: string;
  platform: string;
  status: 'active' | 'revoked';
  public_key: Buffer;
}

interface GrantRow {
  id: string;
  capability: 'device.files.read' | 'device.files.write' | 'device.git.read';
  root: string;
}

interface ExecOptions {
  taskId: string | null;
  idempotencyKey: string;
  correlationId: string;
  timeoutMs?: number;
}

/**
 * DeviceBroker: jedyna droga poleceń do Workerów. Przed WYSŁANIEM sprawdza właściciela, kontekst,
 * aktywny grant zdolności i leksykalnie katalog. Worker powtarza walidację po swojej stronie (kanonicznie).
 */
export class DeviceBroker {
  constructor(
    private readonly db: Db,
    readonly hub: DeviceHub,
  ) {}

  async device(deviceId: string): Promise<DeviceRow | null> {
    const r = await this.db.owner.query<DeviceRow>(
      `SELECT id, household_id, owner_user_id, name, platform, status, public_key FROM devices WHERE id = $1`,
      [deviceId],
    );
    return r.rows[0] ?? null;
  }

  async activeGrants(deviceId: string): Promise<GrantRow[]> {
    const r = await this.db.owner.query<GrantRow>(
      `SELECT id, capability, root FROM device_grants
        WHERE device_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at`,
      [deviceId],
    );
    return r.rows;
  }

  /** Domyślne urządzenie użytkownika (jedyne aktywne); niejednoznaczność => null. */
  async defaultDevice(userId: string): Promise<string | null> {
    const r = await this.db.owner.query<{ id: string }>(
      `SELECT id FROM devices WHERE owner_user_id = $1 AND status = 'active'`,
      [userId],
    );
    return r.rows.length === 1 ? r.rows[0]!.id : null;
  }

  /** Autoryzacja bez wysyłki (używana przy planowaniu narzędzia i tuż przed wysłaniem). */
  async check(
    principal: Principal,
    context: ContextKind,
    deviceId: string,
    capability: DeviceCapability,
    params: Record<string, unknown>,
  ): Promise<{ decision: Decision; device: DeviceRow | null }> {
    const schema = CommandParams[capability];
    if (!schema.safeParse(params).success)
      return { decision: { allow: false, reason: 'invalid_params' }, device: null };
    const device = await this.device(deviceId);
    if (!device) return { decision: { allow: false, reason: 'device_not_found' }, device: null };
    if (device.status !== 'active')
      return { decision: { allow: false, reason: 'device_revoked' }, device };
    const grants = await this.activeGrants(deviceId);
    const needed = GRANT_FOR[capability];
    const decision = decide(
      { userId: principal.userId, activeHouseholdIds: principal.activeHouseholdIds, context },
      needed,
      {
        type: 'device',
        id: deviceId,
        ownerUserId: device.owner_user_id,
        householdId: device.household_id,
        visibility: 'private',
        grants: grants.map((g) => ({ capability: g.capability, root: g.root })),
      },
    );
    if (!decision.allow) return { decision, device };
    const path = String(params.path ?? params.repoPath ?? '');
    const roots = grants.filter((g) => g.capability === needed).map((g) => g.root);
    if (!roots.some((root) => isWithinRoot(path, root))) {
      return { decision: { allow: false, reason: 'path_outside_grant' }, device };
    }
    return { decision, device };
  }

  async execute(
    principal: Principal,
    context: ContextKind,
    deviceId: string,
    capability: DeviceCapability,
    params: Record<string, unknown>,
    opts: ExecOptions,
  ): Promise<Record<string, unknown>> {
    const { decision, device } = await this.check(principal, context, deviceId, capability, params);
    const audit = (outcome: 'allow' | 'deny' | 'ok' | 'error', details: Record<string, unknown>) =>
      writeAudit(this.db, {
        actorKind: context === 'user' ? 'user' : 'agent',
        actorUserId: principal.userId,
        ownerUserId: device?.owner_user_id ?? null,
        householdId: device?.household_id ?? null,
        source: 'broker',
        action: `device.command`,
        resourceType: 'device',
        resourceId: deviceId,
        tool: capability,
        outcome,
        correlationId: opts.correlationId,
        params,
        details,
      });
    if (!decision.allow) {
      await audit('deny', { reason: decision.reason });
      throw new DeviceDenied(decision.reason);
    }

    const prev = await this.db.owner.query<{ status: string; result_summary: string | null }>(
      `SELECT status, result_summary FROM device_commands WHERE idempotency_key = $1`,
      [opts.idempotencyKey],
    );
    if (prev.rows[0]?.status === 'ok' && capability === 'device.files.write') {
      // Zapis już wykonany dla tego klucza — nie wysyłamy ponownie.
      return { replay: true, summary: prev.rows[0].result_summary };
    }
    await this.db.owner.query(
      `INSERT INTO device_commands (device_id, owner_user_id, task_id, capability, params_hash, idempotency_key, status)
       VALUES ($1,$2,$3,$4,$5,$6,'sent')
       ON CONFLICT (idempotency_key) DO UPDATE SET status = 'sent', completed_at = NULL`,
      [
        deviceId,
        device!.owner_user_id,
        opts.taskId,
        capability,
        hashParams(params),
        opts.idempotencyKey,
      ],
    );
    let result: ResultPayload;
    try {
      result = await this.hub.send(
        deviceId,
        { capability, params, taskId: opts.taskId, idempotencyKey: opts.idempotencyKey },
        opts.timeoutMs ?? 30_000,
      );
    } catch (err) {
      const status = err instanceof DeviceTimeout ? 'expired' : 'error';
      await this.db.owner.query(
        `UPDATE device_commands SET status = $2, result_summary = $3, completed_at = now() WHERE idempotency_key = $1`,
        [opts.idempotencyKey, status, (err as Error).message],
      );
      await audit('error', { error: (err as Error).message });
      throw err;
    }
    const summary =
      result.status === 'ok'
        ? summarize(capability, result.output)
        : (result.error ?? result.status);
    await this.db.owner.query(
      `UPDATE device_commands SET status = $2, result_summary = $3, completed_at = now() WHERE idempotency_key = $1`,
      [opts.idempotencyKey, result.status, summary.slice(0, 500)],
    );
    if (result.status === 'denied') {
      await audit('deny', { reason: `worker:${result.error ?? ''}` });
      throw new DeviceDenied(`worker:${result.error ?? 'denied'}`);
    }
    if (result.status === 'error') {
      await audit('error', { error: result.error });
      throw new DeviceCommandFailed(result.error ?? 'błąd polecenia');
    }
    await audit('ok', {});
    return result.output ?? {};
  }
}

function summarize(capability: DeviceCapability, out: Record<string, unknown> | null): string {
  if (!out) return 'ok';
  switch (capability) {
    case 'device.files.list':
      return `${Array.isArray(out.entries) ? out.entries.length : 0} pozycji`;
    case 'device.files.read':
      return `odczytano ${String(out.size ?? '?')} B`;
    case 'device.files.write':
      return `zapisano ${String(out.size ?? '?')} B`;
    default:
      return 'ok';
  }
}
