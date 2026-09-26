import {
  decide,
  type Action,
  type Actor,
  type ContextKind,
  type ResourceMeta,
  type ResourceType,
} from '@nova/permissions';
import type { FastifyRequest } from 'fastify';
import { writeAudit } from './audit';
import type { AuthContext } from './auth/session';
import type { Db } from './db/pool';
import { forbidden, notFound, unauthorized } from './lib/errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function actorFor(auth: AuthContext, context: ContextKind = 'user'): Actor {
  return { userId: auth.userId, activeHouseholdIds: auth.activeHouseholdIds, context };
}

/** Zapytania o metadane własności — bez treści. Wykonywane rolą systemową. */
const META_SQL: Partial<Record<ResourceType, string>> = {
  conversation: `SELECT owner_user_id, household_id, visibility FROM conversations WHERE id = $1`,
  memory: `SELECT m.owner_user_id, m.household_id, m.visibility,
                  EXISTS (SELECT 1 FROM memory_grants g WHERE g.memory_id = m.id AND g.revoked_at IS NULL)
                    AS active_share_grant
             FROM memories m WHERE m.id = $1`,
  task: `SELECT owner_user_id, household_id, visibility FROM tasks WHERE id = $1`,
  approval: `SELECT owner_user_id, household_id, 'private'::text AS visibility FROM approvals WHERE id = $1`,
  device: `SELECT owner_user_id, household_id, 'private'::text AS visibility FROM devices WHERE id = $1`,
  document: `SELECT owner_user_id, household_id, visibility FROM documents WHERE id = $1`,
};

const READ_ACTION: Partial<Record<ResourceType, Action>> = {
  conversation: 'conversation.read',
  memory: 'memory.read',
  task: 'task.read',
  approval: 'approval.read',
  device: 'device.read',
  document: 'document.read',
};

export async function loadMeta(
  db: Db,
  type: ResourceType,
  id: string,
): Promise<ResourceMeta | null> {
  const sql = META_SQL[type];
  if (!sql) throw new Error(`Brak zapytania metadanych dla ${type}`);
  const { rows } = await db.owner.query<{
    owner_user_id: string;
    household_id: string;
    visibility: 'private' | 'shared';
    active_share_grant?: boolean;
  }>(sql, [id]);
  const r = rows[0];
  if (!r) return null;
  return {
    type,
    id,
    ownerUserId: r.owner_user_id,
    householdId: r.household_id,
    visibility: r.visibility,
    activeShareGrant: r.active_share_grant,
  };
}

/**
 * Autoryzacja operacji na istniejącym zasobie (warstwa 1). Po niej zapytanie z treścią
 * i tak przechodzi przez RLS (warstwa 2).
 *  - brak zasobu lub brak prawa odczytu => 404 (bez ujawniania istnienia) + wpis audytu,
 *  - prawo odczytu, ale nie tej operacji => 403 + wpis audytu.
 */
export async function authorize(
  db: Db,
  req: FastifyRequest,
  type: ResourceType,
  id: string,
  action: Action,
  context: ContextKind = 'user',
): Promise<ResourceMeta> {
  const auth = requireAuth(req);
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  if (!isUuid(id)) throw notFound(label);
  const meta = await loadMeta(db, type, id);
  if (!meta) throw notFound(label);
  const actor = actorFor(auth, context);
  const decision = decide(actor, action, meta);
  if (decision.allow) return meta;

  const readAction = READ_ACTION[type];
  const canRead = readAction ? decide(actor, readAction, meta).allow : false;
  await writeAudit(db, {
    actorKind: 'user',
    actorUserId: auth.userId,
    ownerUserId: meta.ownerUserId,
    householdId: meta.householdId,
    source: 'api',
    action,
    resourceType: type,
    resourceId: id,
    outcome: 'deny',
    correlationId: req.id,
    details: { reason: decision.reason, context },
  });
  if (!canRead) throw notFound(label);
  throw forbidden();
}
