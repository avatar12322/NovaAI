import { api } from './api';

/**
 * Powiadomienia push w przeglądarce: wymagają service workera (zbudowana aplikacja), Push API i zgody.
 * iPhone/iPad (iOS 16.4+): tylko w aplikacji dodanej do ekranu głównego, zgoda po dotknięciu przycisku.
 */
export type PushSupport = 'ok' | 'ios-install' | 'unsupported';

/** Błąd z komunikatem dla użytkownika (zgoda, brak service workera, konfiguracja serwera). */
export class PushSetupError extends Error {}

export function pushSupport(): PushSupport {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
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

async function registration(): Promise<ServiceWorkerRegistration | null> {
  return (await navigator.serviceWorker.getRegistration()) ?? null;
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
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw new PushSetupError(
      permission === 'denied'
        ? 'Powiadomienia są zablokowane — włącz je w ustawieniach urządzenia (Powiadomienia → NovaAI).'
        : 'Nie udzielono zgody na powiadomienia.',
    );
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Wyłączenie na tym urządzeniu (także przy wylogowaniu — powiadomienia nie trafiają do następnej osoby). */
export async function disablePush(): Promise<void> {
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
