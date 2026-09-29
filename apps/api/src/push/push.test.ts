import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDev } from '../db/seed';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { allowedEndpoint } from './routes';
import { PushService, vapidSubject } from './service';

/** Web Push: subskrypcje, szyfrowanie treści (RFC 8291), wysyłka powiadomień, wygasłe urządzenia. */
interface Sent {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer | null;
}
let t: TestApp;
let alfa: Client;
let beta: Client;
const sent: Sent[] = [];
let status = 201;

beforeAll(async () => {
  t = await createTestApp(
    {},
    {
      pushTransport: async (r) => {
        sent.push(r);
        return status;
      },
    },
  );
});
afterAll(async () => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  t.seed = await seedDev(t.db, 'test');
  alfa = await login(t.app, 'alfa');
  beta = await login(t.app, 'beta');
  sent.length = 0;
  status = 201;
});

/** „Telefon”: para kluczy P-256 i sekret uwierzytelnienia, jak z pushManager.subscribe(). */
function fakeDevice(name: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    sub: {
      endpoint: `http://127.0.0.1/push/${name}`,
      keys: {
        p256dh: ecdh.getPublicKey().toString('base64url'),
        auth: auth.toString('base64url'),
      },
      label: name,
    },
  };
}

/** Odszyfrowanie aes128gcm (RFC 8188 + RFC 8291) — tak jak robi to przeglądarka. */
function decrypt(body: Buffer, dev: ReturnType<typeof fakeDevice>): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
  const shared = dev.ecdh.computeSecret(asPublic);
  const prkKey = hmac(dev.auth, shared);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    dev.ecdh.getPublicKey(),
    asPublic,
  ]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  const end = plain.lastIndexOf(2); // ogranicznik ostatniego rekordu, dalej dopełnienie zerami
  return plain.subarray(0, end).toString('utf8');
}

async function notify(userId: string, title: string, body: string, minutesAgo = 0) {
  await t.db.owner.query(
    `INSERT INTO notifications (household_id, user_id, kind, title, body, created_at)
     VALUES ($1, $2, 'reminder', $3, $4, now() - make_interval(mins => $5))`,
    [t.seed.householdId, userId, title, body, minutesAgo],
  );
}

describe('powiadomienia push', () => {
  it('włączenie na urządzeniu, zaszyfrowana treść z podpisem VAPID, wysyłka raz', async () => {
    const cfg = (await alfa.get('/api/push/config')).body;
    expect(cfg.available).toBe(true);
    expect(Buffer.from(cfg.publicKey, 'base64url')).toHaveLength(65);
    // Ten sam klucz po ponownym uruchomieniu (zapisany zaszyfrowany w bazie).
    const again = new PushService(t.db, t.deps.vault, 'https://nova.example.test');
    expect(await again.publicKey()).toBe(cfg.publicKey);

    const phone = fakeDevice('iphone');
    expect((await alfa.post('/api/push/subscriptions', phone.sub)).status).toBe(201);
    const list = (await alfa.get('/api/push/subscriptions')).body.items;
    expect(list.map((x: { label: string }) => x.label)).toEqual(['iphone']);
    expect((await beta.get('/api/push/subscriptions')).body.items).toEqual([]);

    await notify(t.seed.users.alfa, 'Przypomnienie', 'Kolokwium z analizy o 8:00');
    await notify(t.seed.users.beta, 'Przypomnienie', 'Beta nie ma urządzeń');
    await notify(t.seed.users.alfa, 'Stare', 'sprzed godziny', 60);
    expect(await t.deps.push.dispatchPending()).toBe(2);
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.endpoint).toBe(phone.sub.endpoint);
    expect(req.headers['Content-Encoding']).toBe('aes128gcm');
    expect(req.headers.Authorization).toMatch(new RegExp(`^vapid t=.+, k=${cfg.publicKey}$`));
    expect(Number(req.headers.TTL)).toBeGreaterThan(0);
    const payload = JSON.parse(decrypt(req.body!, phone));
    expect(payload).toEqual({
      title: 'Przypomnienie',
      body: 'Kolokwium z analizy o 8:00',
      url: '/#/home',
    });
    // Każde powiadomienie tylko raz.
    expect(await t.deps.push.dispatchPending()).toBe(0);
    expect(sent).toHaveLength(1);

    // Test z Ustawień.
    const test = await alfa.post('/api/push/test');
    expect(test.body.delivered).toBe(1);
    expect(JSON.parse(decrypt(sent[1]!.body!, phone)).body).toContain('działają');

    const audit = await t.db.owner.query(
      `SELECT details::text AS d FROM audit_log WHERE action = 'push.subscribe'`,
    );
    expect(audit.rows[0].d).toContain('127.0.0.1');
    expect(audit.rows[0].d).not.toContain('/push/iphone');
  });

  it('wygasła subskrypcja (410) jest usuwana; wyłączenie tylko własnego urządzenia', async () => {
    const phone = fakeDevice('stary');
    await alfa.post('/api/push/subscriptions', phone.sub);
    expect(
      (await beta.post('/api/push/unsubscribe', { endpoint: phone.sub.endpoint })).body.removed,
    ).toBe(0);
    status = 410;
    await notify(t.seed.users.alfa, 'Przypomnienie', 'x');
    await t.deps.push.dispatchPending();
    expect((await alfa.get('/api/push/subscriptions')).body.items).toEqual([]);

    status = 201;
    await alfa.post('/api/push/subscriptions', phone.sub);
    expect(
      (await alfa.post('/api/push/unsubscribe', { endpoint: phone.sub.endpoint })).body.removed,
    ).toBe(1);
  });

  it('tylko znane usługi push (bez dowolnych adresów) i poprawne klucze', async () => {
    const phone = fakeDevice('zly');
    for (const endpoint of ['https://evil.example/push', 'http://10.0.0.1/x', 'ftp://x'])
      expect((await alfa.post('/api/push/subscriptions', { ...phone.sub, endpoint })).status).toBe(
        400,
      );
    expect(
      (
        await alfa.post('/api/push/subscriptions', {
          ...phone.sub,
          keys: { p256dh: 'nie base64!', auth: 'x' },
        })
      ).status,
    ).toBe(400);
    expect(allowedEndpoint('https://web.push.apple.com/QGx', true)).toBe(true);
    expect(allowedEndpoint('https://fcm.googleapis.com/fcm/send/abc', true)).toBe(true);
    expect(allowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x', true)).toBe(
      true,
    );
    expect(allowedEndpoint('https://push.apple.com.evil.example/x', true)).toBe(false);
    expect(allowedEndpoint('http://127.0.0.1/push/x', true)).toBe(false);
    expect(vapidSubject('https://novaai.pl', 'a@example.test')).toBe('https://novaai.pl');
    expect(vapidSubject('http://localhost:5173', 'a@example.test')).toBe('mailto:a@example.test');
  });
});
