import { DOCUMENT_LIMITS } from '@nova/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withUserTx } from '../db/pool';
import { seedDev } from '../db/seed';
import { makePdf } from '../test/pdf-fixture';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';

/**
 * Pamięć dokumentów: indeksowanie w kolejce, wyszukiwanie z lokalizacją, limity i błędy odczytu,
 * usuwanie, ponowne indeksowanie oraz izolacja dwóch osób (API + RLS).
 */
let t: TestApp;
let alfa: Client;
let beta: Client;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  t.seed = await seedDev(t.db, 'test');
  alfa = await login(t.app, 'alfa');
  beta = await login(t.app, 'beta');
});

async function upload(
  c: Client,
  name: string,
  bytes: Buffer,
  space: 'private' | 'shared' = 'private',
) {
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/documents?name=${encodeURIComponent(name)}&space=${space}`,
    headers: { cookie: c.cookie, 'x-nova-csrf': '1', 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
  return { status: res.statusCode, body: res.json() as any };
}

async function uploadReady(
  c: Client,
  name: string,
  bytes: Buffer,
  space: 'private' | 'shared' = 'private',
) {
  const r = await upload(c, name, bytes, space);
  expect(r.status).toBe(201);
  await t.drain();
  const doc = (await c.get(`/api/documents/${r.body.document.id}`)).body;
  expect(doc.status).toBe('ready');
  return doc as { id: string; pageCount: number | null; chunkCount: number };
}

const search = async (c: Client, q: string) =>
  (await c.get(`/api/documents/search?q=${encodeURIComponent(q)}`)).body.items as any[];

const UMOWA = makePdf([
  ['Umowa najmu mieszkania', 'Strony umowy: Wynajmujacy i Najemca.'],
  ['Kaucja wynosi 3000 zl i jest zwracana w ciagu 30 dni od konca umowy.'],
  ['Okres wypowiedzenia umowy wynosi trzy miesiace.'],
]);

describe('dodawanie i wyszukiwanie', () => {
  it('PDF: indeksowanie w kolejce, trafienie wskazuje stronę, oryginał do pobrania jako załącznik', async () => {
    const r = await upload(alfa, 'Umowa najmu.pdf', UMOWA);
    expect(r.status).toBe(201);
    expect(r.body.document).toMatchObject({
      title: 'Umowa najmu',
      format: 'pdf',
      status: 'pending',
      visibility: 'private',
      isMine: true,
    });
    await t.drain();
    const doc = (await alfa.get(`/api/documents/${r.body.document.id}`)).body;
    expect(doc).toMatchObject({ status: 'ready', pageCount: 3, error: null });
    expect(doc.chunkCount).toBe(3);

    const hits = await search(alfa, 'Ile wynosi kaucja?');
    expect(hits[0]).toMatchObject({ documentId: doc.id, title: 'Umowa najmu', page: 2 });
    expect(hits[0].snippet.filter((s: any) => s.hit).map((s: any) => s.text)).toEqual([
      'Kaucja',
      'wynosi',
    ]);
    // Odmiana: „wypowiedzenia” ↔ „wypowiedzenie”, „umowy” ↔ „umowa”; najwięcej trafionych termów wygrywa.
    expect((await search(alfa, 'wypowiedzenie umowy'))[0].page).toBe(3);

    const chunk = (await alfa.get(`/api/documents/${doc.id}/chunks/${hits[0].ord}`)).body;
    expect(chunk).toMatchObject({ page: 2, chunkCount: 3 });
    expect(chunk.content).toContain('3000 zl');

    const file = await t.app.inject({
      url: `/api/documents/${doc.id}/file`,
      headers: { cookie: alfa.cookie },
    });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(UMOWA)).toBe(true);
    expect(file.headers['content-disposition']).toContain('attachment;');
    expect(file.headers['content-disposition']).toContain("filename*=UTF-8''Umowa%20najmu.pdf");
    expect(file.headers['content-security-policy']).toContain('sandbox');
  });

  it('Markdown: nagłówek i zakres linii; TXT w Windows-1250 z polskimi znakami', async () => {
    const md =
      '# Dom\n\n## Ogrzewanie\n\nPiec gazowy serwisuje firma Ciepło, telefon 500 600 700.\n';
    const doc = await uploadReady(alfa, 'dom.md', Buffer.from(md));
    const hit = (await search(alfa, 'serwis pieca'))[0];
    expect(hit).toMatchObject({ documentId: doc.id, heading: 'Dom › Ogrzewanie', page: null });
    expect([hit.lineStart, hit.lineEnd]).toEqual([3, 5]);

    // „Śmieci w Łodzi odbierane są we wtorki” w Windows-1250.
    const cp1250 = Buffer.from(
      new Uint8Array([
        0x8c, 0x6d, 0x69, 0x65, 0x63, 0x69, 0x20, 0x77, 0x20, 0xa3, 0x6f, 0x64, 0x7a, 0x69,
      ]),
    );
    await uploadReady(
      alfa,
      'smieci.txt',
      Buffer.concat([cp1250, Buffer.from(' odbierane w czwartki.')]),
    );
    const h2 = (await search(alfa, 'śmieci łódź'))[0];
    expect(h2.snippet.map((s: any) => s.text).join('')).toContain('Śmieci w Łodzi');
    expect([h2.lineStart, h2.lineEnd]).toEqual([1, 1]);
  });
});

describe('trafność', () => {
  it('rzadki term waży więcej niż słowo obecne w całym dokumencie', async () => {
    const sections = ['Kuchnia', 'Salon', 'Sypialnia', 'Łazienka', 'Balkon'].map(
      (s) =>
        `## ${s}\n\nOpis pomieszczenia w mieszkaniu: ${s.toLowerCase()} jest w mieszkaniu od strony ulicy.`,
    );
    const md = `# Mieszkanie\n\n${sections.join('\n\n')}\n\n## Sprzęty\n\nPralka ma gwarancję do 2027 roku.\n`;
    await uploadReady(alfa, 'mieszkanie.md', Buffer.from(md));
    const hits = await search(alfa, 'gwarancja pralki w mieszkaniu');
    expect(hits[0].heading).toBe('Mieszkanie › Sprzęty');
  });
});

describe('limity i błędy odczytu', () => {
  it('pusty, nieobsługiwany, udający PDF, za duży, duplikat, brak miejsca', async () => {
    expect((await upload(alfa, 'a.txt', Buffer.alloc(0))).status).toBe(400);
    const docx = await upload(alfa, 'a.docx', Buffer.from('PK'));
    expect(docx).toMatchObject({ status: 415, body: { error: { code: 'unsupported_format' } } });
    const fake = await upload(alfa, 'a.pdf', Buffer.from('to nie jest pdf'));
    expect(fake).toMatchObject({ status: 415, body: { error: { code: 'invalid_pdf' } } });
    const big = await upload(alfa, 'duzy.txt', Buffer.alloc(DOCUMENT_LIMITS.maxBytes + 1, 0x61));
    expect(big.status).toBe(413);
    expect(big.body.error.message).toContain('10 MB');

    const first = await upload(alfa, 'a.txt', Buffer.from('treść'));
    const dup = await upload(alfa, 'kopia.txt', Buffer.from('treść'));
    expect(dup).toMatchObject({ status: 409, body: { error: { code: 'duplicate' } } });
    expect(dup.body.error.details.documentId).toBe(first.body.document.id);
    // Ten sam plik u innej osoby to osobny dokument.
    expect((await upload(beta, 'a.txt', Buffer.from('treść'))).status).toBe(201);

    await t.db.owner.query(`UPDATE documents SET size_bytes = $1 WHERE id = $2`, [
      DOCUMENT_LIMITS.maxTotalBytesPerUser,
      first.body.document.id,
    ]);
    const full = await upload(alfa, 'b.txt', Buffer.from('inna treść'));
    expect(full).toMatchObject({ status: 413, body: { error: { code: 'storage_full' } } });
  });

  it('uszkodzony PDF i skan bez tekstu => status „failed” z komunikatem; binarny TXT odrzucony', async () => {
    const broken = await upload(
      alfa,
      'zly.pdf',
      Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> smieci'),
    );
    const scan = await upload(alfa, 'skan.pdf', makePdf([[]]));
    const binary = await upload(alfa, 'bin.txt', Buffer.from([0x41, 0x00, 0x42, 0x43]));
    await t.drain();
    const get = async (id: string) => (await alfa.get(`/api/documents/${id}`)).body;
    expect(await get(broken.body.document.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Nie udało się odczytać pliku PDF'),
      chunkCount: 0,
    });
    expect((await get(scan.body.document.id)).error).toContain('OCR');
    expect((await get(binary.body.document.id)).error).toContain('binarny');
    // Zadania indeksowania zakończone bez ponawiania (błąd treści, nie awaria).
    const tasks = await t.db.owner.query(
      `SELECT status, attempts FROM tasks WHERE kind = 'document.index' ORDER BY created_at`,
    );
    expect(tasks.rows.every((r) => r.status === 'completed')).toBe(true);
  });
});

describe('usuwanie i ponowne indeksowanie', () => {
  it('ponowne indeksowanie: nowa wersja, starsze zadanie pominięte, wynik ten sam', async () => {
    const doc = await uploadReady(alfa, 'Umowa.pdf', UMOWA);
    const a = await alfa.post(`/api/documents/${doc.id}/reindex`);
    const b = await alfa.post(`/api/documents/${doc.id}/reindex`);
    expect(a.status).toBe(200);
    expect(b.body.document.status).toBe('pending');
    // W trakcie ponownego indeksowania stare fragmenty nadal są wyszukiwalne.
    expect((await search(alfa, 'kaucja')).length).toBe(1);
    await t.drain();
    const outputs = await t.db.owner.query(
      `SELECT s.output FROM task_steps s JOIN tasks t ON t.id = s.task_id
        WHERE t.kind = 'document.index' ORDER BY t.created_at`,
    );
    expect(outputs.rows.map((r) => r.output.skipped ?? 'indexed')).toEqual([
      'indexed',
      'superseded',
      'indexed',
    ]);
    expect((await alfa.get(`/api/documents/${doc.id}`)).body).toMatchObject({
      status: 'ready',
      chunkCount: 3,
    });
    expect((await search(alfa, 'kaucja')).length).toBe(1);
  });

  it('usunięcie: dokument, oryginał i fragmenty znikają; zaległe indeksowanie pominięte', async () => {
    const r = await upload(alfa, 'Umowa.pdf', UMOWA);
    const id = r.body.document.id;
    expect((await alfa.del(`/api/documents/${id}`)).status).toBe(200);
    await t.drain();
    expect((await alfa.get(`/api/documents/${id}`)).status).toBe(404);
    expect(await search(alfa, 'kaucja')).toEqual([]);
    const left = await t.db.owner.query(
      `SELECT (SELECT count(*) FROM document_chunks)::int AS c, (SELECT count(*) FROM document_blobs)::int AS b`,
    );
    expect(left.rows[0]).toEqual({ c: 0, b: 0 });
    const step = await t.db.owner.query(
      `SELECT s.output FROM task_steps s JOIN tasks t ON t.id = s.task_id WHERE t.kind = 'document.index'`,
    );
    expect(step.rows[0].output).toEqual({ skipped: 'deleted' });
  });
});

describe('izolacja: prywatny dokument Alfy nie istnieje dla Bety', () => {
  const SECRET = makePdf([['Szyfr do sejfu: 4411-9020', 'Sejf stoi w gabinecie.']]);

  it('lista, szczegóły, fragment, plik, wyszukiwanie i akcje => 404 dla Bety; odmowy w audycie', async () => {
    const doc = await uploadReady(alfa, 'Sejf.pdf', SECRET);
    expect((await search(alfa, 'sejf')).length).toBe(1);

    for (const space of ['private', 'shared'])
      expect((await beta.get(`/api/documents?space=${space}`)).body.items).toEqual([]);
    expect(await search(beta, 'sejf szyfr 4411')).toEqual([]);
    for (const url of [
      `/api/documents/${doc.id}`,
      `/api/documents/${doc.id}/chunks/0`,
      `/api/documents/${doc.id}/file`,
    ])
      expect((await beta.get(url)).status).toBe(404);
    for (const path of ['share', 'unshare', 'reindex'])
      expect((await beta.post(`/api/documents/${doc.id}/${path}`)).status).toBe(404);
    expect((await beta.del(`/api/documents/${doc.id}`)).status).toBe(404);
    const denies = await t.db.owner.query(
      `SELECT action FROM audit_log WHERE actor_user_id = $1 AND outcome = 'deny' AND resource_type = 'document'`,
      [t.seed.users.beta],
    );
    expect(denies.rows.length).toBe(7);
    expect((await alfa.get(`/api/documents/${doc.id}`)).body.status).toBe('ready');
  });

  it('RLS bez filtra w zapytaniu: Beta nie widzi wierszy dokumentów, oryginałów ani fragmentów Alfy', async () => {
    await uploadReady(alfa, 'Sejf.pdf', SECRET);
    const counts = await withUserTx(t.db, { userId: t.seed.users.beta, scope: 'user' }, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM documents)::int AS d, (SELECT count(*) FROM document_chunks)::int AS ch,
                (SELECT count(*) FROM document_blobs)::int AS b`,
      ),
    );
    expect(counts.rows[0]).toEqual({ d: 0, ch: 0, b: 0 });
    // NovaAI (scope shared) nie widzi prywatnego dokumentu nawet w kontekście właściciela.
    const asShared = await withUserTx(t.db, { userId: t.seed.users.alfa, scope: 'shared' }, (c) =>
      c.query(`SELECT count(*)::int AS n FROM document_chunks`),
    );
    expect(asShared.rows[0].n).toBe(0);
  });

  it('udostępnienie: Beta czyta i wyszukuje, ale nie zarządza; cofnięcie działa natychmiast', async () => {
    const doc = await uploadReady(alfa, 'Sejf.pdf', SECRET);
    expect((await alfa.post(`/api/documents/${doc.id}/share`)).body.visibility).toBe('shared');
    expect((await beta.get('/api/documents?space=shared')).body.items[0]).toMatchObject({
      id: doc.id,
      isMine: false,
      ownerName: 'Alfa (test)',
    });
    expect((await search(beta, 'sejf'))[0].documentId).toBe(doc.id);
    expect((await beta.get(`/api/documents/${doc.id}/file`)).status).toBe(200);
    for (const path of ['unshare', 'reindex'])
      expect((await beta.post(`/api/documents/${doc.id}/${path}`)).status).toBe(403);
    expect((await beta.del(`/api/documents/${doc.id}`)).status).toBe(403);

    await alfa.post(`/api/documents/${doc.id}/unshare`);
    expect(await search(beta, 'sejf')).toEqual([]);
    expect((await beta.get(`/api/documents/${doc.id}`)).status).toBe(404);
    const chunks = await t.db.owner.query(`SELECT DISTINCT visibility FROM document_chunks`);
    expect(chunks.rows).toEqual([{ visibility: 'private' }]);
  });

  it('po odebraniu członkostwa Beta nie widzi wspólnych dokumentów', async () => {
    const doc = await uploadReady(alfa, 'Sejf.pdf', SECRET, 'shared');
    expect((await search(beta, 'sejf')).length).toBe(1);
    await t.db.owner.query(
      `UPDATE memberships SET status = 'revoked', revoked_at = now() WHERE user_id = $1`,
      [t.seed.users.beta],
    );
    const betaAgain = await login(t.app, 'beta');
    expect(await search(betaAgain, 'sejf')).toEqual([]);
    expect((await betaAgain.get(`/api/documents/${doc.id}`)).status).toBe(404);
  });
});
