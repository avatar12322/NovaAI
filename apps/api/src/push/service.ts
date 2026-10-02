import webpush from 'web-push';
import type { Vault } from '../connectors/vault';
import type { Db } from '../db/pool';
import { withSystemTx } from '../db/pool';

/**
 * Powiadomienia push (Web Push, RFC 8030/8291/8292): każde nowe powiadomienie w aplikacji trafia także na
 * urządzenia, na których osoba włączyła powiadomienia (iPhone: aplikacja dodana do ekranu głównego, iOS 16.4+).
 * Treść jest szyfrowana dla urządzenia (usługa push — Apple, Google, Mozilla — jej nie widzi). Wysyłka jest
 * „najlepszą próbą”: powiadomienie zostaje w aplikacji (Dom → Wiadomości) niezależnie od push.
 */

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Adres w aplikacji otwierany po dotknięciu powiadomienia. */
  url: string;
  /** Powiadomienia z tym samym tagiem zastępują się (np. przegląd dnia). */
  tag?: string;
}

/** Wynik wysyłki: `gone` — subskrypcja wygasła (404/410), do usunięcia. */
export type PushResult = 'ok' | 'gone' | 'error';

/** Transport do usługi push — w testach podmieniany (lokalny mock). */
export type PushTransport = (req: {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer | null;
}) => Promise<number>;

const fetchTransport: PushTransport = async (req) => {
  const res = await fetch(req.endpoint, {
    method: 'POST',
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) await res.arrayBuffer().catch(() => undefined);
  else {
    // Powód odrzucenia od usługi push (np. Apple: {"reason":"BadJwtToken"}) — do dziennika serwera.
    const reason = (await res.text().catch(() => '')).slice(0, 200);
    console.error(`[push] ${new URL(req.endpoint).hostname}: ${res.status} ${reason}`.trim());
  }
  return res.status;
};

/** Czas życia powiadomienia w usłudze push, gdy urządzenie jest offline (sekundy). */
const TTL_SECONDS = 12 * 3600;
const MAX_FAILURES = 5;
const BATCH = 50;
/** Starsze niż to powiadomienia nie są już wysyłane jako push (np. po dłuższej przerwie serwera). */
const MAX_AGE = '30 minutes';

const vapidAad = 'push:vapid:v1';

interface Vapid {
  publicKey: string;
  privateKey: string;
}

export class PushService {
  private vapid: Promise<Vapid> | null = null;

  constructor(
    private readonly db: Db,
    private readonly vault: Vault | null,
    /** Nadawca w tokenie VAPID (adres aplikacji) — usługi push mogą się nim kontaktować w razie problemów. */
    private readonly subject: string,
    private readonly transport: PushTransport = fetchTransport,
  ) {}

  /** Push wymaga klucza szyfrowania (NOVA_SECRET_KEY) — bez niego klucza VAPID nie da się bezpiecznie zapisać. */
  get available(): boolean {
    return this.vault !== null;
  }

  /** Klucz publiczny VAPID (applicationServerKey dla przeglądarki); tworzony przy pierwszym użyciu. */
  async publicKey(): Promise<string> {
    return (await this.keys()).publicKey;
  }

  private keys(): Promise<Vapid> {
    if (!this.vault) return Promise.reject(new Error('push_unavailable'));
    const vault = this.vault;
    this.vapid ??= withSystemTx(this.db, async (c) => {
      const cur = await c.query<{ public_key: string; private_ciphertext: Buffer; key_id: string }>(
        'SELECT public_key, private_ciphertext, key_id FROM push_vapid WHERE id = 1',
      );
      const row = cur.rows[0];
      if (row)
        return {
          publicKey: row.public_key,
          privateKey: vault.decrypt(row.private_ciphertext, row.key_id, vapidAad),
        };
      const k = webpush.generateVAPIDKeys();
      const enc = vault.encrypt(k.privateKey, vapidAad);
      // Równoległy start: wygrywa pierwszy zapis, pozostali czytają jego klucz.
      await c.query(
        `INSERT INTO push_vapid (id, public_key, private_ciphertext, key_id) VALUES (1, $1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [k.publicKey, enc.blob, enc.keyId],
      );
      const saved = await c.query<{
        public_key: string;
        private_ciphertext: Buffer;
        key_id: string;
      }>('SELECT public_key, private_ciphertext, key_id FROM push_vapid WHERE id = 1');
      const s = saved.rows[0]!;
      return {
        publicKey: s.public_key,
        privateKey: vault.decrypt(s.private_ciphertext, s.key_id, vapidAad),
      };
    }).catch((e: unknown) => {
      this.vapid = null;
      throw e;
    });
    return this.vapid;
  }

  /** Rotacja NOVA_SECRET_KEY: ponowne zaszyfrowanie klucza VAPID (sam klucz — i subskrypcje — bez zmian). */
  async rotate(): Promise<number> {
    if (!this.vault) return 0;
    const r = await this.db.owner.query<{ private_ciphertext: Buffer; key_id: string }>(
      'SELECT private_ciphertext, key_id FROM push_vapid WHERE id = 1',
    );
    const row = r.rows[0];
    if (!row || !this.vault.needsRotation(row.key_id)) return 0;
    const enc = this.vault.encrypt(
      this.vault.decrypt(row.private_ciphertext, row.key_id, vapidAad),
      vapidAad,
    );
    await this.db.owner.query(
      'UPDATE push_vapid SET private_ciphertext = $1, key_id = $2 WHERE id = 1',
      [enc.blob, enc.keyId],
    );
    return 1;
  }

  /** Wysyłka jednego powiadomienia na jedno urządzenie. */
  async send(sub: PushSubscriptionKeys, msg: PushMessage): Promise<PushResult> {
    const vapid = await this.keys();
    const details = webpush.generateRequestDetails(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(msg),
      {
        TTL: TTL_SECONDS,
        urgency: 'normal',
        ...(msg.tag ? { topic: topicOf(msg.tag) } : {}),
        vapidDetails: {
          subject: this.subject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
      },
    );
    // Nagłówki jako tekst; Content-Length ustala klient HTTP.
    const headers = Object.fromEntries(
      Object.entries(details.headers as Record<string, unknown>)
        .filter(([k]) => k.toLowerCase() !== 'content-length')
        .map(([k, v]) => [k, String(v)]),
    );
    try {
      const status = await this.transport({
        endpoint: details.endpoint,
        headers,
        body: (details.body as Buffer | null) ?? null,
      });
      if (status === 404 || status === 410) return 'gone';
      return status >= 200 && status < 300 ? 'ok' : 'error';
    } catch {
      return 'error';
    }
  }

  /** Wysyłka do wszystkich urządzeń osoby; wygasłe subskrypcje są usuwane. Zwraca liczbę dostarczonych. */
  async sendToUser(userId: string, msg: PushMessage): Promise<number> {
    const subs = await this.db.owner.query<PushSubscriptionKeys & { id: string }>(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
      [userId],
    );
    let ok = 0;
    for (const s of subs.rows) {
      const r = await this.send(s, msg);
      if (r === 'ok') {
        ok++;
        await this.db.owner.query(
          'UPDATE push_subscriptions SET last_ok_at = now(), failures = 0 WHERE id = $1',
          [s.id],
        );
      } else if (r === 'gone') {
        await this.db.owner.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
      } else {
        // Powtarzające się błędy (np. zepsuta subskrypcja) — po kilku próbach subskrypcja jest usuwana.
        await this.db.owner.query(
          `DELETE FROM push_subscriptions WHERE id = $1 AND failures + 1 >= $2`,
          [s.id, MAX_FAILURES],
        );
        await this.db.owner.query(
          'UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1',
          [s.id],
        );
      }
    }
    return ok;
  }

  /**
   * Nowe powiadomienia z aplikacji → push. Każde oznaczane jako obsłużone przed wysyłką (bez powtórek po
   * błędzie sieci); osoby bez urządzeń są pomijane. Zwraca liczbę obsłużonych powiadomień.
   */
  async dispatchPending(): Promise<number> {
    if (!this.available) return 0;
    const batch = await withSystemTx(this.db, async (c) => {
      const r = await c.query<{
        id: string;
        user_id: string;
        kind: string;
        title: string;
        body: string;
        ref_type: string | null;
      }>(
        `SELECT id, user_id, kind, title, body, ref_type FROM notifications
          WHERE push_handled_at IS NULL AND created_at > now() - interval '${MAX_AGE}'
          ORDER BY created_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`,
      );
      if (r.rows.length)
        await c.query(
          'UPDATE notifications SET push_handled_at = now() WHERE id = ANY($1::uuid[])',
          [r.rows.map((x) => x.id)],
        );
      return r.rows;
    });
    for (const n of batch) {
      await this.sendToUser(n.user_id, {
        title: n.title,
        body: n.body.length > 300 ? `${n.body.slice(0, 299)}…` : n.body,
        url: '/#/home',
        tag: n.kind === 'briefing' ? `briefing` : undefined,
      }).catch((e: unknown) => {
        // Błąd po stronie serwera (np. konfiguracja) — nie usuwa subskrypcji; widoczny w dzienniku.
        console.error(`[push] ${e instanceof Error ? e.message : String(e)}`);
        return 0;
      });
    }
    return batch.length;
  }
}

/** Temat (nagłówek Topic): do 32 znaków base64url — zastępuje niedostarczone jeszcze wcześniejsze. */
function topicOf(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'nova';
}

/**
 * Nadawca w tokenie VAPID: usługi push (także Apple) przyjmują tylko adres https: albo mailto:.
 * Produkcja: adres aplikacji; lokalnie (http://localhost) — kontakt administratora albo adres zastępczy.
 */
export function vapidSubject(publicUrl: string, contactEmail: string): string {
  if (publicUrl.startsWith('https://')) return publicUrl;
  return `mailto:${contactEmail || 'nova@localhost.invalid'}`;
}

/** Okresowa wysyłka push w procesie API. */
export function startPushDispatcher(push: PushService, everyMs = 4000): () => void {
  let busy = false;
  const iv = setInterval(() => {
    if (busy) return;
    busy = true;
    void push
      .dispatchPending()
      .catch(() => 0)
      .finally(() => {
        busy = false;
      });
  }, everyMs);
  return () => clearInterval(iv);
}
