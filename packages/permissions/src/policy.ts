/**
 * Polityka dostępu NovaAI — czyste funkcje, domyślna odmowa.
 *
 * Kontekst żądania (kto pyta i w jakiej przestrzeni) wyznacza serwer na podstawie sesji.
 * Model ani klient nigdy nie wskazują właściciela — dostają tylko wynik decyzji.
 * Ta warstwa jest pierwszą barierą; drugą jest Row Level Security w Postgres (0002_rls.sql).
 */

export type Visibility = 'private' | 'shared';

/**
 * - `user`: bezpośrednie działanie użytkownika w UI/API (własne prywatne + jawnie wspólne).
 * - `private_agent`: prywatny agent użytkownika (to samo co `user`, ale bez zarządzania uprawnieniami).
 * - `household_agent`: wspólny agent NovaAI — wyłącznie jawnie wspólne dane (i free/busy z grantu).
 */
export type ContextKind = 'user' | 'private_agent' | 'household_agent';

export interface Actor {
  userId: string;
  /** Domy, w których użytkownik ma AKTYWNE członkostwo (z bazy, nie z żądania). */
  activeHouseholdIds: ReadonlySet<string>;
  context: ContextKind;
}

export type ResourceType =
  | 'conversation'
  | 'message'
  | 'memory'
  | 'task'
  | 'approval'
  | 'device'
  | 'connection'
  | 'calendar'
  | 'notification'
  | 'budget';

export interface ResourceMeta {
  type: ResourceType;
  id?: string;
  ownerUserId: string;
  householdId: string;
  visibility: Visibility;
  /** Dla pamięci: czy istnieje aktywny grant udostępnienia. */
  activeShareGrant?: boolean;
  /** Dla kalendarza/urządzeń: grant wydany kontekstowi, np. free/busy dla NovaAI. */
  grants?: ReadonlyArray<ResourceGrant>;
}

export interface ResourceGrant {
  capability: Action;
  /** Dla urządzeń: korzeń katalogu (już skanonikalizowany po stronie brokera). */
  root?: string;
  revokedAt?: Date | null;
  expiresAt?: Date | null;
}

export const ACTIONS = [
  'conversation.read',
  'conversation.write',
  'conversation.create',
  'memory.read',
  'memory.create',
  'memory.update',
  'memory.delete',
  'memory.share',
  'memory.unshare',
  'task.read',
  'task.create',
  'task.cancel',
  'approval.read',
  'approval.resolve',
  'calendar.freebusy',
  'calendar.details',
  'device.read',
  'device.manage',
  'device.files.read',
  'device.files.write',
  'device.command.execute',
  'connection.read',
  'connection.manage',
  'budget.read',
  'budget.manage',
  'household.notify',
  'reminder.create',
] as const;
export type Action = (typeof ACTIONS)[number];

export interface Decision {
  allow: boolean;
  reason: string;
}

const allow = (reason: string): Decision => ({ allow: true, reason });
const deny = (reason: string): Decision => ({ allow: false, reason });

/** Działania, które wymagają bycia właścicielem zasobu (niezależnie od udostępnienia). */
const OWNER_ONLY: ReadonlySet<Action> = new Set<Action>([
  'memory.update',
  'memory.delete',
  'memory.share',
  'memory.unshare',
  'task.cancel',
  'approval.read',
  'approval.resolve',
  'calendar.details',
  'device.read',
  'device.manage',
  'device.files.read',
  'device.files.write',
  'device.command.execute',
  'connection.read',
  'connection.manage',
]);

/** Działania zarządzające uprawnieniami — nigdy nie wykonuje ich agent (model). */
const HUMAN_ONLY: ReadonlySet<Action> = new Set<Action>([
  'memory.share',
  'memory.unshare',
  'memory.delete',
  'approval.resolve',
  'device.manage',
  'connection.manage',
  'budget.manage',
  'task.cancel',
]);

/** Działania odczytu/zapisu, dla których „shared” daje dostęp członkom domu. */
const SHARED_READABLE: ReadonlySet<Action> = new Set<Action>([
  'conversation.read',
  'conversation.write',
  'memory.read',
  'task.read',
]);

function isShared(res: ResourceMeta): boolean {
  if (res.visibility !== 'shared') return false;
  // Pamięć jest wspólna wyłącznie przy aktywnym jawnym grancie.
  if (res.type === 'memory') return res.activeShareGrant === true;
  return true;
}

function activeGrant(res: ResourceMeta, action: Action, now: Date): ResourceGrant | undefined {
  return res.grants?.find(
    (g) =>
      g.capability === action &&
      !g.revokedAt &&
      (!g.expiresAt || g.expiresAt.getTime() > now.getTime()),
  );
}

/**
 * Decyzja dostępu do istniejącego zasobu. Domyślnie odmowa.
 */
export function decide(
  actor: Actor,
  action: Action,
  res: ResourceMeta,
  now: Date = new Date(),
): Decision {
  if (!actor.userId) return deny('no_actor');
  if (!actor.activeHouseholdIds.has(res.householdId)) {
    // Brak aktywnego członkostwa odcina również dostęp do wspólnych danych.
    // Własne prywatne dane pozostają dostępne właścicielowi w kontekście user.
    if (!(
      res.ownerUserId === actor.userId &&
      actor.context === 'user' &&
      res.visibility === 'private'
    )) {
      return deny('not_active_member');
    }
  }
  if (HUMAN_ONLY.has(action) && actor.context !== 'user') return deny('human_only_action');

  const isOwner = res.ownerUserId === actor.userId;

  // Kalendarz: NovaAI dostaje tylko free/busy i tylko z aktywnego grantu.
  if (action === 'calendar.freebusy') {
    if (isOwner && actor.context !== 'household_agent') return allow('owner');
    return activeGrant(res, action, now) ? allow('freebusy_grant') : deny('no_freebusy_grant');
  }

  // Urządzenia: właściciel + aktywny grant zdolności (katalog weryfikuje broker i Worker).
  if (
    action === 'device.files.read' ||
    action === 'device.files.write' ||
    action === 'device.command.execute'
  ) {
    if (!isOwner) return deny('not_owner');
    if (actor.context === 'household_agent') return deny('household_agent_no_device');
    return activeGrant(res, action, now) ? allow('device_grant') : deny('no_device_grant');
  }

  if (actor.context === 'household_agent') {
    // Agent wspólny: wyłącznie jawnie wspólne zasoby, niezależnie od tego, kto pyta.
    if (SHARED_READABLE.has(action) && isShared(res)) return allow('shared_resource');
    return deny('household_agent_shared_only');
  }

  if (isOwner) return allow('owner');
  if (OWNER_ONLY.has(action)) return deny('not_owner');
  if (SHARED_READABLE.has(action) && isShared(res)) return allow('shared_resource');
  return deny('not_visible');
}

/** Tworzenie nowego zasobu w domu (właściciel = aktor, zawsze z sesji). */
export function decideCreate(
  actor: Actor,
  action: Extract<Action, 'conversation.create' | 'memory.create' | 'task.create'>,
  target: { householdId: string; visibility: Visibility },
): Decision {
  if (!actor.userId) return deny('no_actor');
  if (!actor.activeHouseholdIds.has(target.householdId)) return deny('not_active_member');
  if (actor.context === 'household_agent' && target.visibility !== 'shared') {
    return deny('household_agent_shared_only');
  }
  return allow('member_create');
}

/**
 * Filtr zakresu dla zapytań listujących (RAG, listy): co w ogóle wolno pobrać w danym kontekście.
 * Zwraca zakres dla RLS (`nova.scope`) — filtr jest stosowany PRZED pobraniem danych.
 */
export function scopeFor(context: ContextKind): 'user' | 'shared' {
  return context === 'household_agent' ? 'shared' : 'user';
}

/**
 * Wiadomość do innego członka domu (narzędzie `household.notify`). Wymaga zgody nadawcy
 * na dokładną treść — tu sprawdzamy wyłącznie, czy nadawca i odbiorca są w tym samym domu.
 */
export function decideHouseholdNotify(
  actor: Actor,
  target: { householdId: string; targetUserId: string; targetActiveMember: boolean },
): Decision {
  if (!actor.userId) return deny('no_actor');
  if (actor.context === 'household_agent') return deny('household_agent_no_direct_messages');
  if (!actor.activeHouseholdIds.has(target.householdId)) return deny('not_active_member');
  if (!target.targetActiveMember) return deny('target_not_member');
  if (target.targetUserId === actor.userId) return deny('target_is_self');
  return allow('household_member');
}
