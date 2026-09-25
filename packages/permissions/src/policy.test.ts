import { describe, expect, it } from 'vitest';
import {
  decide,
  decideCreate,
  decideHouseholdNotify,
  scopeFor,
  type Actor,
  type ResourceMeta,
} from './policy';

const H = 'h-1';
const OTHER_H = 'h-2';
const ALFA = 'u-alfa';
const BETA = 'u-beta';

const actor = (userId: string, context: Actor['context'] = 'user', households = [H]): Actor => ({
  userId,
  context,
  activeHouseholdIds: new Set(households),
});

const res = (over: Partial<ResourceMeta> = {}): ResourceMeta => ({
  type: 'conversation',
  ownerUserId: ALFA,
  householdId: H,
  visibility: 'private',
  ...over,
});

describe('izolacja prywatnych danych', () => {
  it('Alfa czyta własną prywatną rozmowę', () => {
    expect(decide(actor(ALFA), 'conversation.read', res()).allow).toBe(true);
  });
  it('Beta nie czyta prywatnej rozmowy Alfy', () => {
    const d = decide(actor(BETA), 'conversation.read', res());
    expect(d).toEqual({ allow: false, reason: 'not_visible' });
  });
  it('Alfa nie czyta prywatnej pamięci Bety', () => {
    expect(
      decide(actor(ALFA), 'memory.read', res({ type: 'memory', ownerUserId: BETA })).allow,
    ).toBe(false);
  });
  it('NovaAI nie widzi prywatnych danych nawet właściciela, który pyta', () => {
    expect(decide(actor(ALFA, 'household_agent'), 'conversation.read', res()).allow).toBe(false);
    expect(
      decide(
        actor(ALFA, 'household_agent'),
        'memory.read',
        res({ type: 'memory', activeShareGrant: false }),
      ).allow,
    ).toBe(false);
  });
  it('prywatny agent Bety nie widzi prywatnych danych Alfy', () => {
    expect(decide(actor(BETA, 'private_agent'), 'memory.read', res({ type: 'memory' })).allow).toBe(
      false,
    );
  });
});

describe('dane wspólne', () => {
  it('wspólna rozmowa jest widoczna dla drugiego członka i NovaAI', () => {
    const shared = res({ visibility: 'shared' });
    expect(decide(actor(BETA), 'conversation.read', shared).allow).toBe(true);
    expect(decide(actor(BETA, 'household_agent'), 'conversation.read', shared).allow).toBe(true);
  });
  it('pamięć shared bez aktywnego grantu NIE jest wspólna', () => {
    const m = res({ type: 'memory', visibility: 'shared', activeShareGrant: false });
    expect(decide(actor(BETA), 'memory.read', m).allow).toBe(false);
    expect(decide(actor(ALFA, 'household_agent'), 'memory.read', m).allow).toBe(false);
  });
  it('pamięć z aktywnym grantem jest widoczna, ale tylko właściciel ją edytuje i cofa', () => {
    const m = res({ type: 'memory', visibility: 'shared', activeShareGrant: true });
    expect(decide(actor(BETA), 'memory.read', m).allow).toBe(true);
    expect(decide(actor(BETA), 'memory.update', m).allow).toBe(false);
    expect(decide(actor(BETA), 'memory.unshare', m).allow).toBe(false);
    expect(decide(actor(ALFA), 'memory.unshare', m).allow).toBe(true);
  });
  it('bez aktywnego członkostwa wspólne dane są niedostępne', () => {
    const shared = res({ visibility: 'shared', ownerUserId: BETA });
    expect(decide(actor(ALFA, 'user', []), 'conversation.read', shared).allow).toBe(false);
    expect(decide(actor(ALFA, 'user', [OTHER_H]), 'conversation.read', shared).allow).toBe(false);
  });
  it('household_id nie wystarcza: prywatny zasób w tym samym domu pozostaje prywatny', () => {
    expect(decide(actor(BETA), 'task.read', res({ type: 'task' })).allow).toBe(false);
  });
});

describe('działania zastrzeżone dla człowieka', () => {
  it('agent nie udostępnia pamięci ani nie zatwierdza zgód', () => {
    const m = res({ type: 'memory' });
    expect(decide(actor(ALFA, 'private_agent'), 'memory.share', m).reason).toBe(
      'human_only_action',
    );
    expect(
      decide(actor(ALFA, 'private_agent'), 'approval.resolve', res({ type: 'approval' })).allow,
    ).toBe(false);
  });
  it('tylko właściciel rozstrzyga swoją zgodę', () => {
    const a = res({ type: 'approval' });
    expect(decide(actor(ALFA), 'approval.resolve', a).allow).toBe(true);
    expect(decide(actor(BETA), 'approval.resolve', a).allow).toBe(false);
  });
});

describe('kalendarz i granty', () => {
  const cal = (grants: ResourceMeta['grants']) =>
    res({ type: 'calendar', ownerUserId: BETA, grants });
  it('NovaAI dostaje free/busy wyłącznie z aktywnego grantu', () => {
    expect(decide(actor(ALFA, 'household_agent'), 'calendar.freebusy', cal([])).allow).toBe(false);
    expect(
      decide(
        actor(ALFA, 'household_agent'),
        'calendar.freebusy',
        cal([{ capability: 'calendar.freebusy' }]),
      ).allow,
    ).toBe(true);
  });
  it('odwołany lub wygasły grant nie działa', () => {
    const now = new Date('2026-09-25T12:00:00Z');
    const revoked = cal([
      { capability: 'calendar.freebusy', revokedAt: new Date('2026-09-25T11:00:00Z') },
    ]);
    const expired = cal([
      { capability: 'calendar.freebusy', expiresAt: new Date('2026-09-25T11:59:59Z') },
    ]);
    expect(decide(actor(ALFA, 'household_agent'), 'calendar.freebusy', revoked, now).allow).toBe(
      false,
    );
    expect(decide(actor(ALFA, 'household_agent'), 'calendar.freebusy', expired, now).allow).toBe(
      false,
    );
  });
  it('szczegóły kalendarza nigdy dla drugiej osoby ani NovaAI', () => {
    const c = cal([{ capability: 'calendar.freebusy' }]);
    expect(decide(actor(ALFA), 'calendar.details', c).allow).toBe(false);
    expect(decide(actor(ALFA, 'household_agent'), 'calendar.details', c).allow).toBe(false);
    expect(decide(actor(BETA), 'calendar.details', c).allow).toBe(true);
  });
});

describe('urządzenia', () => {
  const dev = (grants: ResourceMeta['grants'], owner = ALFA) =>
    res({ type: 'device', ownerUserId: owner, grants });
  it('polecenie na cudze urządzenie jest odrzucone', () => {
    const d = dev([{ capability: 'device.files.read', root: 'C:/proj' }], BETA);
    expect(decide(actor(ALFA), 'device.files.read', d).reason).toBe('not_owner');
    expect(decide(actor(ALFA, 'private_agent'), 'device.files.read', d).allow).toBe(false);
  });
  it('zdolność spoza grantu jest odrzucona', () => {
    const d = dev([{ capability: 'device.files.read', root: 'C:/proj' }]);
    expect(decide(actor(ALFA, 'private_agent'), 'device.files.read', d).allow).toBe(true);
    expect(decide(actor(ALFA, 'private_agent'), 'device.files.write', d).reason).toBe(
      'no_device_grant',
    );
    expect(decide(actor(ALFA, 'private_agent'), 'device.command.execute', d).allow).toBe(false);
  });
  it('NovaAI nie używa urządzeń', () => {
    const d = dev([{ capability: 'device.files.read' }]);
    expect(decide(actor(ALFA, 'household_agent'), 'device.files.read', d).allow).toBe(false);
  });
});

describe('tworzenie i zakres', () => {
  it('tworzenie tylko w domu z aktywnym członkostwem', () => {
    expect(
      decideCreate(actor(ALFA), 'memory.create', { householdId: H, visibility: 'private' }).allow,
    ).toBe(true);
    expect(
      decideCreate(actor(ALFA), 'memory.create', { householdId: OTHER_H, visibility: 'private' })
        .allow,
    ).toBe(false);
  });
  it('NovaAI tworzy wyłącznie zasoby wspólne', () => {
    expect(
      decideCreate(actor(ALFA, 'household_agent'), 'task.create', {
        householdId: H,
        visibility: 'private',
      }).allow,
    ).toBe(false);
  });
  it('zakres RLS dla kontekstów', () => {
    expect(scopeFor('user')).toBe('user');
    expect(scopeFor('private_agent')).toBe('user');
    expect(scopeFor('household_agent')).toBe('shared');
  });
  it('nieznany aktor => odmowa', () => {
    expect(decide(actor(''), 'conversation.read', res()).allow).toBe(false);
  });
});

describe('wiadomości w domu', () => {
  const t = { householdId: H, targetUserId: BETA, targetActiveMember: true };
  it('członek domu może wysłać wiadomość drugiemu członkowi (zgoda wymagana osobno)', () => {
    expect(decideHouseholdNotify(actor(ALFA), t).allow).toBe(true);
    expect(decideHouseholdNotify(actor(ALFA, 'private_agent'), t).allow).toBe(true);
  });
  it('NovaAI, obcy dom, nieaktywny odbiorca i wysyłka do siebie są odrzucane', () => {
    expect(decideHouseholdNotify(actor(ALFA, 'household_agent'), t).allow).toBe(false);
    expect(decideHouseholdNotify(actor(ALFA, 'user', [OTHER_H]), t).allow).toBe(false);
    expect(decideHouseholdNotify(actor(ALFA), { ...t, targetActiveMember: false }).allow).toBe(
      false,
    );
    expect(decideHouseholdNotify(actor(ALFA), { ...t, targetUserId: ALFA }).allow).toBe(false);
  });
});
