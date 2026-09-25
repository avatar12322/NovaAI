import type { Db, Queryable } from './db/pool';
import { hashParams } from './lib/crypto';
import { redact } from './lib/redact';

export interface AuditEntry {
  actorKind: 'user' | 'agent' | 'system' | 'device';
  actorUserId?: string | null;
  ownerUserId?: string | null;
  householdId?: string | null;
  source: 'api' | 'queue' | 'broker' | 'worker' | 'connector' | 'system';
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  tool?: string | null;
  outcome: 'allow' | 'deny' | 'ok' | 'error';
  correlationId?: string | null;
  /** Parametry są zapisywane wyłącznie jako skrót SHA-256. */
  params?: unknown;
  /** Szczegóły są redagowane (sekrety, treść). Nie wkładaj tu treści prywatnych. */
  details?: Record<string, unknown>;
}

/**
 * Zapis do dziennika audytu przez rolę systemową, POZA transakcją biznesową —
 * dzięki temu odmowy są zapisywane także wtedy, gdy żądanie kończy się błędem.
 */
export async function writeAudit(target: Db | Queryable, e: AuditEntry): Promise<void> {
  const q: Queryable = 'owner' in target ? target.owner : target;
  await q.query(
    `INSERT INTO audit_log (actor_kind, actor_user_id, owner_user_id, household_id, source, action,
       resource_type, resource_id, tool, outcome, correlation_id, params_hash, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      e.actorKind,
      e.actorUserId ?? null,
      e.ownerUserId ?? null,
      e.householdId ?? null,
      e.source,
      e.action,
      e.resourceType ?? null,
      e.resourceId ?? null,
      e.tool ?? null,
      e.outcome,
      e.correlationId ?? null,
      e.params === undefined ? null : hashParams(e.params),
      JSON.stringify(redact(e.details ?? {})),
    ],
  );
}
