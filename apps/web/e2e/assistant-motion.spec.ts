import { expect, test, type Page } from '@playwright/test';
import { shot, loginAs } from './helpers';

/**
 * Animacje asystenta: wskaźnik pracy z etapem i „kulą”, wejście nowych wiadomości, odsłanianie odpowiedzi;
 * wiadomości z historii bez animacji; „ogranicz ruch” wyłącza animacje. Tryb demo (bez modelu).
 */

async function newConversation(page: Page) {
  await page.goto('/#/chat/private');
  await page.getByRole('button', { name: 'Nowa' }).click();
  await expect(page.locator('#composer-input')).toBeVisible();
}

test('asystent „myśli” z etapem, nowa odpowiedź wchodzi z animacją; historia bez animacji', async ({
  page,
}) => {
  // Bez strumienia zdarzeń koniec tury wykryje dopiero odpytywanie (co 2 s) — wskaźnik jest widoczny dłużej.
  await page.route('**/api/events/stream', (r) => r.abort());
  // Syntezator mowy pod kontrolą testu: odczyt trwa do „Zatrzymaj” (cancel kończy wypowiedź).
  await page.addInitScript(() => {
    const synth = window.speechSynthesis;
    let current: SpeechSynthesisUtterance | null = null;
    synth.speak = (u) => {
      current = u;
    };
    synth.cancel = () => {
      const u = current;
      current = null;
      u?.onend?.(new Event('end') as SpeechSynthesisEvent);
    };
  });
  await loginAs(page, 'Alfa (test)');
  await newConversation(page);
  await page.locator('#composer-input').fill('co pamiętasz?');
  await page.getByRole('button', { name: 'Wyślij' }).click();

  const mine = page.locator('.msg-mine').last();
  await expect(mine).toHaveClass(/msg-enter/);
  await expect(mine).toHaveCSS('animation-name', 'msg-in-mine');
  const activity = page.locator('.ai-activity');
  await expect(activity).toBeVisible();
  await expect(activity).toHaveAttribute('role', 'status');
  await expect(activity).toContainText(/Zaczyna|Myśli/);
  await expect(page.locator('.conv-head .orb')).toHaveClass(/orb-thinking/);
  await shot(page, '19-assistant-thinking');

  const reply = page.locator('.msg-assistant[data-fresh]').last();
  await expect(reply).toContainText('tryb demo', { timeout: 10_000 });
  await expect(activity).toHaveCount(0);
  await expect(page.locator('.conv-head .orb')).toHaveClass(/orb-idle/);
  await expect(reply).toHaveCSS('animation-name', 'msg-in');
  // Po odsłonięciu: zwykły tekst, bez kursora.
  await expect(reply.locator('.revealing')).toHaveCount(0);

  // Ponowne otwarcie rozmowy: te same wiadomości już bez animacji.
  await page.reload();
  await expect(page.locator('.msg-assistant').last()).toContainText('tryb demo');
  await expect(page.locator('.msg[data-fresh]')).toHaveCount(0);
  await expect(page.locator('.msg-enter')).toHaveCount(0);

  // Odczyt na głos: kula „mówi”, przycisk pokazuje equalizer i zatrzymuje odczyt.
  const orb = page.locator('.conv-head .orb');
  await page.getByRole('button', { name: 'Odczytaj odpowiedź' }).last().click();
  await expect(orb).toHaveClass(/orb-speaking/);
  const stop = page.getByRole('button', { name: 'Zatrzymaj odczyt' });
  await expect(stop.locator('.eq')).toBeVisible();
  await stop.click();
  await expect(orb).toHaveClass(/orb-idle/);
});

test.describe('ograniczony ruch', () => {
  test('„ogranicz ruch”: bez animacji wejścia i bez odsłaniania tekstu', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAs(page, 'Alfa (test)');
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
      true,
    );
    await newConversation(page);
    await page.locator('#composer-input').fill('co pamiętasz?');
    await page.getByRole('button', { name: 'Wyślij' }).click();
    await expect(page.locator('.msg-mine').last()).toHaveCSS('animation-name', 'none');
    const reply = page.locator('.msg-assistant').last();
    await expect(reply).toContainText('tryb demo', { timeout: 10_000 });
    await expect(reply.locator('.revealing')).toHaveCount(0);
    await expect(reply).toHaveCSS('animation-name', 'none');
  });
});
