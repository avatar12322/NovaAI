import { api } from './api';

/**
 * Powiadomienia push w przeglądarce: wymagają service workera (zbudowana aplikacja), Push API i zgody.
 * iPhone/iPad (iOS 16.4+): tylko w aplikacji dodanej do ekranu głównego, zgoda po dotknięciu przycisku.
 */
export type PushSupport = 'ok' | 'ios-install' | 'unsupported';

/** Błąd z komunikatem dla użytkownika (zgoda, brak service workera, konfiguracja serwera). */
export class PushSetupError extends Error {}

/** iPhone/iPad; iPadOS przedstawia się jako Mac — rozpoznawany po ekranie dotykowym. */
export function isIos(
  ua = navigator.userAgent,
  touchPoints = navigator.maxTouchPoints ?? 0,
): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

export function pushSupport(): PushSupport {
  const ios = isIos();
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const apis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (ios && !standalone) return 'ios-install';
  return apis ? 'ok' : 'unsupported';
}

/** Nazwa urządzenia na liście (bez szczegółów przeglądarki). */
export function deviceLabel(ua = navigator.userAgent): string {
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'urządzenie';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  return browser ? `${device} · ${browser}` : device;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Aktywny service worker. Pierwsze otwarcie z ekranu głównego (iPhone: osobna pamięć, worker instaluje się od nowa):
 * rejestracja już jest, ale worker jeszcze się instaluje — subskrypcja wymaga aktywnego, więc czekamy na `ready`.
 */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  const reg =
    (await navigator.serviceWorker.getRegistration()) ??
    (import.meta.env.PROD
      ? await navigator.serviceWorker.register('/sw.js').catch(() => undefined)
      : undefined);
  if (!reg) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
  ]);
}

/** Osoba, która włączyła powiadomienia na tym urządzeniu (do ponownego zgłoszenia subskrypcji przy starcie). */
const OWNER_KEY = 'nova-push-user';

function pushOwner(): string | null {
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}

function setPushOwner(userId: string | null): void {
  try {
    if (userId) localStorage.setItem(OWNER_KEY, userId);
    else localStorage.removeItem(OWNER_KEY);
  } catch {
    /* storage niedostępny */
  }
}

/** Zgoda systemowa na powiadomienia (null — brak obsługi). */
export function pushPermission(): NotificationPermission | null {
  return 'Notification' in window ? Notification.permission : null;
}

/** Subskrypcja tego urządzenia (jeśli jest). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok') return null;
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/**
 * Włączenie na tym urządzeniu. Wywołać bezpośrednio z obsługi kliknięcia: zgoda musi być pierwszym krokiem
 * (Safari wymaga gestu użytkownika), potem subskrypcja z kluczem serwera i zapis na serwerze.
 */
export async function enablePush(userId: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw new PushSetupError(
      permission === 'denied'
        ? 'Powiadomienia są zablokowane — włącz je w ustawieniach urządzenia (Powiadomienia → NovaAI).'
        : 'Nie udzielono zgody na powiadomienia.',
    );
  await subscribeAndSave();
  setPushOwner(userId);
}

/** Subskrypcja z aktualnym kluczem serwera i zapis na serwerze (zgoda już udzielona — bez gestu). */
async function subscribeAndSave(): Promise<void> {
  const reg = await registration();
  if (!reg)
    throw new PushSetupError(
      'Powiadomienia działają w zainstalowanej aplikacji (novaai.pl), nie w trybie deweloperskim.',
    );
  const cfg = await api.pushConfig();
  if (!cfg.available || !cfg.publicKey)
    throw new PushSetupError('Serwer nie ma skonfigurowanych powiadomień push.');
  let sub = await reg.pushManager.getSubscription();
  // Subskrypcja z innym kluczem serwera (np. po reinstalacji) — zastąpiona nową.
  const key = keyBytes(cfg.publicKey);
  const existing = sub?.options.applicationServerKey;
  if (sub && existing && !sameBytes(new Uint8Array(existing), key)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  try {
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch {
    throw new PushSetupError(
      'Urządzenie nie połączyło się z usługą powiadomień. Sprawdź internet i spróbuj ponownie.',
    );
  }
  const json = sub.toJSON();
  await api.pushSubscribe({
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    label: deviceLabel(),
  });
}

/**
 * Przy starcie aplikacji: jeśli ta osoba włączyła powiadomienia na tym urządzeniu, a serwer nie zna już jego
 * subskrypcji (usunięta po błędach dostarczenia, iPhone wymienił ją na nową, zmiana klucza serwera) — zgłoszenie
 * jej od nowa, bez ponownego pytania o zgodę. Bez zgody systemowej albo po wyłączeniu — nic.
 */
export async function syncPush(userId: string): Promise<void> {
  if (pushSupport() !== 'ok' || Notification.permission !== 'granted') return;
  const owner = pushOwner();
  if (owner !== null && owner !== userId) return;
  const [sub, list] = await Promise.all([currentSubscription(), api.pushDevices()]);
  const known = sub !== null && list.items.some((d) => d.endpoint === sub.endpoint);
  if (owner === null) {
    // Włączone przed zapamiętywaniem osoby: przejęte tylko, gdy serwer przypisuje subskrypcję tej osobie.
    if (known) setPushOwner(userId);
    return;
  }
  if (!known) await subscribeAndSave();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Wyłączenie na tym urządzeniu (także przy wylogowaniu — powiadomienia nie trafiają do następnej osoby). */
export async function disablePush(): Promise<void> {
  setPushOwner(null);
  const sub = await currentSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}

/** Liczba nieprzeczytanych na ikonie aplikacji (Badging API; iPhone — po zgodzie na powiadomienia). */
export function setAppBadge(count: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) void nav.setAppBadge?.(count).catch(() => undefined);
    else void nav.clearAppBadge?.().catch(() => undefined);
  } catch {
    /* brak obsługi */
  }
}
