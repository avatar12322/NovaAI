import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDev } from '../db/seed';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { speakableText } from './routes';

/**
 * Głos ElevenLabs: tylko lokalna atrapa API (bez sieci i bez kosztów). Sprawdza kształt żądania wg dokumentacji,
 * odczyt tylko widocznych odpowiedzi, pamięć podręczną, limit znaków, błędy klucza i brak klucza w odpowiedziach.
 */
const KEY = 'el-test-key-0000000000000000';
const MP3 = Buffer.from('ID3-atrapa-mp3');
let server: Server;
let base: string;
let captured: Array<{ url: string; headers: IncomingMessage['headers']; body: any }> = [];
let status = 200;
/** Długość nagrania w odpowiedzi atrapy rozpoznawania mowy (undefined = pole pominięte). */
let sttSeconds: number | undefined = 4.2;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const json = String(req.headers['content-type']).startsWith('application/json');
      captured.push({
        url: req.url!,
        headers: req.headers,
        body: json ? JSON.parse(raw.toString('utf8')) : raw.toString('latin1'),
      });
      if (req.headers['xi-api-key'] !== KEY || status !== 200) {
        res.writeHead(status === 200 ? 401 : status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: { message: `secret-detail ${KEY}` } }));
        return;
      }
      if (req.url === '/v1/speech-to-text') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            language_code: 'pol',
            language_probability: 0.98,
            text: ' Co mam dziś w planie? ',
            words: [],
            ...(sttSeconds === undefined ? {} : { audio_duration_secs: sttSeconds }),
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(MP3);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('tekst do odczytu', () => {
  it('bez odnośników i znaczników; długi tekst skrócony na końcu zdania', () => {
    expect(speakableText('**Kaucja** wynosi 3000 zł [D1].\n\n# Uwaga')).toBe(
      'Kaucja wynosi 3000 zł . Uwaga',
    );
    const long = 'Zdanie numer jeden jest tutaj. '.repeat(200);
    const out = speakableText(long);
    expect(out.length).toBeLessThanOrEqual(2600);
    expect(out.endsWith('Dalsza część jest w czacie.')).toBe(true);
  });
});

describe('głos ElevenLabs', () => {
  let t: TestApp;
  let alfa: Client;
  let beta: Client;
  beforeAll(async () => {
    t = await createTestApp({ ELEVENLABS_API_KEY: KEY }, { ttsBase: base });
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await truncateAll(t.db);
    t.seed = await seedDev(t.db, 'test');
    alfa = await login(t.app, 'alfa');
    beta = await login(t.app, 'beta');
    captured = [];
    status = 200;
    sttSeconds = 4.2;
  });

  async function reply(
    c: Client,
    space: 'private' | 'shared' = 'private',
    content = 'co pamiętasz?',
  ) {
    const conv = (await c.post('/api/conversations', { space })).body;
    await c.post(`/api/conversations/${conv.id}/messages`, { content });
    await t.drain();
    const items = (await c.get(`/api/conversations/${conv.id}/messages`)).body.items;
    return {
      assistant: items.find((m: any) => m.role === 'assistant'),
      user: items.find((m: any) => m.role === 'user'),
    };
  }
  const tts = (c: Client, body: unknown) =>
    t.app.inject({
      method: 'POST',
      url: '/api/tts',
      headers: { cookie: c.cookie, 'x-nova-csrf': '1' },
      payload: body as object,
    });

  it('odpowiedź asystenta: żądanie wg dokumentacji, MP3, zużycie znaków, bez klucza w odpowiedziach', async () => {
    const s = (await alfa.get('/api/tts/status')).body;
    expect(s).toMatchObject({
      provider: 'elevenlabs',
      voiceId: 'o2xdfKUpc1Bwq7RchZuW',
      modelId: 'eleven_flash_v2_5',
      monthChars: 0,
      monthlyLimit: 30000,
    });
    const { assistant } = await reply(alfa);
    const res = await tts(alfa, { messageId: assistant.id });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.rawPayload.equals(MP3)).toBe(true);

    expect(captured).toHaveLength(1);
    const c = captured[0]!;
    expect(c.url).toBe('/v1/text-to-speech/o2xdfKUpc1Bwq7RchZuW?output_format=mp3_44100_128');
    expect(c.headers['xi-api-key']).toBe(KEY);
    expect(c.body).toEqual({
      text: speakableText(assistant.content),
      model_id: 'eleven_flash_v2_5',
    });

    const used = (await alfa.get('/api/tts/status')).body.monthChars;
    expect(used).toBe(speakableText(assistant.content).length);
    const audit = await t.db.owner.query(
      `SELECT outcome, details::text FROM audit_log WHERE action = 'tts.synthesize'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].outcome).toBe('ok');
    expect(audit.rows[0].details).not.toContain(KEY);
    expect(audit.rows[0].details).not.toContain('pamiętasz');

    // Ponowny odczyt tej samej odpowiedzi — z pamięci podręcznej, bez kosztu.
    expect((await tts(alfa, { messageId: assistant.id })).statusCode).toBe(200);
    expect(captured).toHaveLength(1);
    expect((await alfa.get('/api/tts/status')).body.monthChars).toBe(used);
  });

  it('czyta tylko to, co widać: cudza prywatna odpowiedź i wiadomość użytkownika => 404', async () => {
    const { assistant, user } = await reply(alfa);
    expect((await tts(beta, { messageId: assistant.id })).statusCode).toBe(404);
    expect((await tts(alfa, { messageId: user.id })).statusCode).toBe(404);
    expect((await tts(alfa, { text: 'dowolny tekst' })).statusCode).toBe(400);
    expect(captured).toHaveLength(0);
    // Odpowiedź we wspólnej rozmowie może przeczytać domownik.
    const shared = await reply(alfa, 'shared');
    expect((await tts(beta, { messageId: shared.assistant.id })).statusCode).toBe(200);
  });

  it('przegląd dnia na głos', async () => {
    const res = await tts(alfa, { briefing: true });
    expect(res.statusCode).toBe(200);
    expect(captured[0]!.body.text).toMatch(/^(Dzień dobry|Dobry wieczór), Alfa\. Dziś /);
  });

  it('klucz odrzucony => 502 z czytelnym komunikatem, bez treści odpowiedzi dostawcy', async () => {
    status = 401;
    // Inna treść niż w poprzednich testach — ta sama odpowiedź byłaby już w pamięci podręcznej.
    const { assistant } = await reply(alfa, 'private', 'zapamiętaj: test klucza');
    const res = await tts(alfa, { messageId: assistant.id });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ code: 'tts_rejected' });
    expect(res.body).not.toContain('secret-detail');
    expect(res.body).not.toContain(KEY);
    expect((await alfa.get('/api/tts/status')).body.monthChars).toBe(0);
  });
});

describe('limit i brak konfiguracji', () => {
  it('miesięczny limit znaków => 429; bez klucza => głos przeglądarki (503)', async () => {
    const limited = await createTestApp(
      { ELEVENLABS_API_KEY: KEY, ELEVENLABS_MONTHLY_CHARS: '10' },
      { ttsBase: base },
    );
    try {
      const c = await login(limited.app, 'alfa');
      const res = await limited.app.inject({
        method: 'POST',
        url: '/api/tts',
        headers: { cookie: c.cookie, 'x-nova-csrf': '1' },
        payload: { briefing: true },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('tts_limit');
    } finally {
      await limited.close();
    }
    const plain = await createTestApp();
    try {
      const c = await login(plain.app, 'alfa');
      expect((await c.get('/api/tts/status')).body).toMatchObject({ provider: null });
      const res = await c.post('/api/tts', { briefing: true });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('tts_not_configured');
    } finally {
      await plain.close();
    }
  });
});

describe('rozpoznawanie mowy ElevenLabs (zapas dla przeglądarki)', () => {
  let t: TestApp;
  let alfa: Client;
  const AUDIO = Buffer.alloc(4096, 7); // atrapa nagrania — treść bez znaczenia dla atrapy API
  beforeAll(async () => {
    t = await createTestApp({ ELEVENLABS_API_KEY: KEY }, { ttsBase: base });
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await truncateAll(t.db);
    t.seed = await seedDev(t.db, 'test');
    alfa = await login(t.app, 'alfa');
    captured = [];
    status = 200;
    sttSeconds = 4.2;
  });
  const stt = (
    c: Client | null,
    body: Buffer | string,
    type = 'audio/webm;codecs=opus',
    csrf = true,
  ) =>
    t.app.inject({
      method: 'POST',
      url: '/api/stt',
      headers: {
        'content-type': type,
        ...(c ? { cookie: c.cookie } : {}),
        ...(csrf ? { 'x-nova-csrf': '1' } : {}),
      },
      payload: body,
    });

  it('nagranie → tekst: żądanie wg dokumentacji, zużycie sekund, audyt bez treści i klucza', async () => {
    const res = await stt(alfa, AUDIO);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: 'Co mam dziś w planie?' });

    expect(captured).toHaveLength(1);
    const c = captured[0]!;
    expect(c.url).toBe('/v1/speech-to-text');
    expect(c.headers['xi-api-key']).toBe(KEY);
    expect(c.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(c.body).toMatch(/name="model_id"\r\n\r\nscribe_v2\r\n/);
    expect(c.body).toMatch(/name="language_code"\r\n\r\npol\r\n/);
    expect(c.body).toMatch(/name="file"; filename="nagranie"\r\nContent-Type: audio\/webm\r\n/);
    expect(c.body).toContain(AUDIO.toString('latin1'));

    const s = (await alfa.get('/api/tts/status')).body;
    expect(s.stt).toEqual({
      provider: 'elevenlabs',
      modelId: 'scribe_v2',
      monthMinutes: 1,
      monthlyLimitMinutes: 60,
    });
    const usage = await t.db.owner.query(`SELECT seconds::float AS s FROM stt_usage`);
    expect(usage.rows).toEqual([{ s: 4.2 }]);
    const audit = await t.db.owner.query(
      `SELECT outcome, details::text FROM audit_log WHERE action = 'stt.transcribe'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].outcome).toBe('ok');
    expect(audit.rows[0].details).not.toContain('planie');
    expect(audit.rows[0].details).not.toContain(KEY);
  });

  it('walidacja: format, długość, logowanie i CSRF — bez wywołania ElevenLabs', async () => {
    expect((await stt(alfa, AUDIO, 'audio/flac')).statusCode).toBe(400);
    expect((await stt(alfa, Buffer.alloc(100, 1))).statusCode).toBe(400);
    expect((await stt(alfa, '{"text":"x"}', 'application/json')).statusCode).toBe(400);
    expect((await stt(null, AUDIO)).statusCode).toBe(401);
    expect((await stt(alfa, AUDIO, 'audio/webm', false)).statusCode).toBe(403);
    expect((await stt(alfa, Buffer.alloc(3 * 1024 * 1024 + 1, 1))).statusCode).toBe(413);
    expect(captured).toHaveLength(0);
  });

  it('klucz odrzucony => 502 bez treści odpowiedzi dostawcy i bez zużycia', async () => {
    status = 401;
    const res = await stt(alfa, AUDIO);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('stt_rejected');
    expect(res.body).not.toContain('secret-detail');
    expect(res.body).not.toContain(KEY);
    expect((await t.db.owner.query('SELECT 1 FROM stt_usage')).rows).toHaveLength(0);
  });

  it('bez długości w odpowiedzi liczone jest 30 s (najgorszy przypadek)', async () => {
    sttSeconds = undefined;
    expect((await stt(alfa, AUDIO)).statusCode).toBe(200);
    const usage = await t.db.owner.query(`SELECT seconds::float AS s FROM stt_usage`);
    expect(usage.rows).toEqual([{ s: 30 }]);
  });
});

describe('rozpoznawanie mowy: limit i wyłączenie', () => {
  it('limit minut => 429 po wyczerpaniu; 0 minut albo brak klucza => wyłączone (503)', async () => {
    const limited = await createTestApp(
      { ELEVENLABS_API_KEY: KEY, ELEVENLABS_STT_MONTHLY_MINUTES: '1' },
      { ttsBase: base },
    );
    try {
      const c = await login(limited.app, 'alfa');
      const send = () =>
        limited.app.inject({
          method: 'POST',
          url: '/api/stt',
          headers: { cookie: c.cookie, 'x-nova-csrf': '1', 'content-type': 'audio/ogg' },
          payload: Buffer.alloc(2048, 3),
        });
      sttSeconds = 61;
      expect((await send()).statusCode).toBe(200);
      const res = await send();
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('stt_limit');
    } finally {
      sttSeconds = 4.2;
      await limited.close();
    }
    for (const env of [
      { ELEVENLABS_API_KEY: KEY, ELEVENLABS_STT_MONTHLY_MINUTES: '0' },
      {} as Record<string, string>,
    ]) {
      const off = await createTestApp(env, { ttsBase: base });
      try {
        const c = await login(off.app, 'alfa');
        expect((await c.get('/api/tts/status')).body.stt).toBeNull();
        const res = await off.app.inject({
          method: 'POST',
          url: '/api/stt',
          headers: { cookie: c.cookie, 'x-nova-csrf': '1', 'content-type': 'audio/webm' },
          payload: Buffer.alloc(2048, 3),
        });
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe('stt_not_configured');
      } finally {
        await off.close();
      }
    }
  });
});
