// Przegląd UI na zrzutach (nie jest częścią testów): przygotowuje dane przez API (konta testowe Alfa/Beta,
// tryb demo) i zapisuje zrzuty każdego widoku — desktop i Pixel 7, jasny i ciemny motyw, puste stany,
// błąd serwera i tryb offline.
//
// Wymaga działającego API na bazie nova_e2e (port 4100) i Vite (port 5174), np.:
//   NOVA_ENV=test NOVA_API_PORT=4100 NOVA_WEB_ORIGIN=http://localhost:5174 NOVA_DEV_LOGIN=true \
//   NOVA_RP_ID=localhost DATABASE_URL_APP=…/nova_e2e DATABASE_URL_OWNER=…/nova_e2e \
//   pnpm --filter @nova/api start:e2e
//   NOVA_API_URL=http://127.0.0.1:4100 pnpm --filter @nova/web exec vite --port 5174
// Uruchomienie: node apps/web/scripts/ui-review.mjs <katalog-na-zrzuty>
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:5174';
const OUT = process.argv[2];
const ONLY = process.argv[3] ?? '';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

const newCtx = (kind, dark = false) =>
  browser.newContext({
    ...(kind === 'phone' ? devices['Pixel 7'] : { viewport: { width: 1360, height: 860 } }),
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    colorScheme: dark ? 'dark' : 'light',
  });

async function login(page, who) {
  await page.goto(`${BASE}/`);
  await page.getByRole('button', { name: new RegExp(who.replace(/[()]/g, '\\$&')) }).click();
  await page.locator('.envbar').waitFor();
}
const api = async (page, method, path, data) => {
  const r = await page.request.fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'x-nova-csrf': '1', 'content-type': 'application/json' },
    data,
  });
  return r.json().catch(() => null);
};
const upload = (page, name, body, space = 'private') =>
  page.request.fetch(`${BASE}/api/documents?name=${encodeURIComponent(name)}&space=${space}`, {
    method: 'POST',
    headers: { 'x-nova-csrf': '1', 'content-type': 'application/octet-stream' },
    data: Buffer.from(body),
  });
const settle = (page) => page.waitForTimeout(700);

async function seed() {
  const ctx = await newCtx('desktop');
  const page = await ctx.newPage();
  await login(page, 'Alfa (test)');
  await api(page, 'POST', '/memories', {
    content: 'Preferuję spotkania po 10:00',
    space: 'private',
  });
  await api(page, 'POST', '/memories', { content: 'Alergia na orzechy', space: 'private' });
  await api(page, 'POST', '/memories', { content: 'Śmieci wystawiamy we wtorki', space: 'shared' });
  await upload(
    page,
    'Instrukcja pieca.md',
    '# Piec gazowy\n\n## Serwis\n\nPrzegląd serwisowy raz w roku, najlepiej we wrześniu. Kontakt do serwisu jest w umowie.\n\n## Ciśnienie\n\nCiśnienie w instalacji powinno wynosić od 1,2 do 1,8 bar. Przy spadku poniżej 1 bar dopuść wodę zaworem pod piecem.\n',
    'shared',
  );
  await upload(
    page,
    'Notatki.txt',
    'Hasło do Wi-Fi gości jest na lodówce.\nKod do furtki zmieniony w sierpniu.',
  );
  await upload(page, 'skan-umowy.pdf', '%PDF-1.4\n1 0 obj << >> endobj\nsmieci');
  const conv = await api(page, 'POST', '/conversations', { space: 'private' });
  for (const content of [
    'zapamiętaj: kupić filtr do okapu',
    'Jakie powinno być ciśnienie w piecu?',
    'napisz do Beta (test): kolacja o 19',
  ]) {
    await api(page, 'POST', `/conversations/${conv.id}/messages`, { content });
    await page.waitForTimeout(900);
  }
  await api(page, 'POST', '/tasks', {
    kind: 'demo.workflow',
    message: 'Przypominam o rachunku za prąd',
  });
  await api(page, 'POST', '/reminders', {
    text: 'Wynieść śmieci',
    dueAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
    space: 'shared',
  });
  const shared = await api(page, 'POST', '/conversations', { space: 'shared' });
  await api(page, 'POST', `/conversations/${shared.id}/messages`, {
    content: 'Kiedy jest przegląd serwisowy pieca?',
  });
  await page.waitForTimeout(2500);
  await ctx.close();
  return { conv: conv.id };
}

async function shots(kind, ids, dark = false) {
  const ctx = await newCtx(kind, dark);
  const page = await ctx.newPage();
  const p = `${kind}${dark ? '-dark' : ''}`;
  const snap = async (name, full = false) => {
    await settle(page);
    await page.screenshot({ path: `${OUT}/${p}-${name}.png`, fullPage: full });
  };
  await page.goto(`${BASE}/`);
  await page.getByRole('heading', { name: 'Wybierz konto testowe' }).waitFor();
  await snap('00-login');
  await login(page, 'Alfa (test)');
  const views = [
    ['01-chat-list', '#/chat/private'],
    ['02-conversation', `#/chat/private/${ids.conv}`],
    ['03-shared', '#/chat/shared'],
    ['04-tasks', '#/tasks'],
    ['05-approvals', '#/approvals'],
    ['06-home', '#/home'],
    ['07-memory', '#/memory/private'],
    ['08-documents', '#/documents/private'],
    ['09-documents-shared', '#/documents/shared'],
    ['10-settings', '#/settings'],
  ];
  for (const [name, hash] of views) {
    if (ONLY && !name.includes(ONLY)) continue;
    await page.goto(`${BASE}/${hash}`);
    await snap(name, name === '10-settings' && kind === 'desktop');
  }
  if (!dark) {
    // Zadanie: szczegóły pierwszego zadania.
    await page.goto(`${BASE}/#/tasks`);
    await settle(page);
    const first = page.locator('.split-list a').first();
    if (await first.count()) {
      await first.click();
      await snap('11-task-detail');
    }
    // Wyszukiwanie w dokumentach.
    await page.goto(`${BASE}/#/documents/private`);
    await page.getByLabel('Szukaj w dokumentach').fill('ciśnienie w piecu');
    await page.getByRole('button', { name: 'Szukaj' }).click();
    await snap('12-doc-search');
    // Błąd serwera w widoku pamięci.
    await page.route('**/api/memories?*', (r) =>
      r.fulfill({
        status: 500,
        body: JSON.stringify({ error: { code: 'internal', message: 'Błąd serwera' } }),
      }),
    );
    await page.goto(`${BASE}/#/memory/private`);
    await snap('13-error');
    await page.unroute('**/api/memories?*');
    // Offline.
    await ctx.setOffline(true);
    await page.goto(`${BASE}/#/home`).catch(() => undefined);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await snap('14-offline');
    await ctx.setOffline(false);
    // Puste stany: Beta.
    await page.goto(`${BASE}/#/settings`);
    await page.getByRole('button', { name: 'Wyloguj' }).last().click();
    await login(page, 'Beta (test)');
    for (const [name, hash] of [
      ['15-empty-chat', '#/chat/private'],
      ['16-empty-documents', '#/documents/private'],
      ['17-empty-approvals', '#/approvals'],
      ['18-empty-tasks', '#/tasks'],
    ]) {
      await page.goto(`${BASE}/${hash}`);
      await snap(name);
    }
  }
  await ctx.close();
}

const ids = await seed();
await shots('desktop', ids);
await shots('phone', ids);
await shots('desktop', ids, true);
await shots('phone', ids, true);
await browser.close();
console.log('ok');
