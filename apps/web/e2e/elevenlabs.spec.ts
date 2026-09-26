import { expect, test, type Page } from '@playwright/test';
import { loginAs, newConversation } from './helpers';

/**
 * Głos ElevenLabs w przeglądarce: odpowiedzi serwera `/api/tts` są tu symulowane (bez klucza i bez kosztów),
 * odtwarzanie dźwięku — atrapą. Sprawdza, co przeglądarka wysyła, i powrót do głosu przeglądarki po błędzie.
 */
type W = { __played: string[]; __spoken: string[]; __finish: () => void };

async function setup(page: Page, ttsStatus: number) {
  const bodies: unknown[] = [];
  await page.addInitScript(() => {
    const w = window as unknown as W;
    w.__played = [];
    w.__spoken = [];
    // Atrapa odtwarzacza: dźwięk „gra”, dopóki test nie zakończy go przez __finish().
    class FakeAudio {
      onended: ((e: Event) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      constructor(public src: string) {}
      play() {
        w.__played.push(this.src);
        w.__finish = () => this.onended?.(new Event('ended'));
        return Promise.resolve();
      }
      pause() {}
    }
    (window as unknown as { Audio: unknown }).Audio = FakeAudio;
    window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
      w.__spoken.push(u.text);
      setTimeout(() => u.onend?.(new Event('end') as SpeechSynthesisEvent), 100);
    };
    window.speechSynthesis.cancel = () => undefined;
  });
  await page.route('**/api/tts/status', (r) =>
    r.fulfill({
      json: {
        provider: 'elevenlabs',
        voiceId: 'o2xdfKUpc1Bwq7RchZuW',
        modelId: 'eleven_flash_v2_5',
        monthChars: 120,
        monthlyLimit: 30000,
      },
    }),
  );
  await page.route('**/api/tts', (r) => {
    bodies.push(r.request().postDataJSON());
    return ttsStatus === 200
      ? r.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from('ID3-atrapa') })
      : r.fulfill({
          status: ttsStatus,
          json: { error: { code: 'tts_limit', message: 'limit' } },
        });
  });
  return bodies;
}

const played = (page: Page) => page.evaluate(() => (window as unknown as W).__played);
const spoken = (page: Page) => page.evaluate(() => (window as unknown as W).__spoken);

test('ElevenLabs: przegląd i odpowiedź czytane głosem z serwera; status w Ustawieniach', async ({
  page,
}) => {
  const bodies = await setup(page, 200);
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/home');
  const panel = page.getByRole('region', { name: 'Przegląd dnia' });
  await panel.getByRole('button', { name: 'Przeczytaj przegląd' }).click();
  await expect.poll(() => played(page)).toHaveLength(1);
  expect((await played(page))[0]).toMatch(/^blob:/);
  expect(bodies).toEqual([{ briefing: true }]);
  await expect(panel.locator('.orb')).toHaveClass(/orb-speaking/);
  await page.evaluate(() => (window as unknown as W).__finish());
  await expect(panel.locator('.orb')).toHaveClass(/orb-idle/);
  expect(await spoken(page)).toEqual([]);

  await newConversation(page);
  await page.locator('#composer-input').fill('co pamiętasz?');
  await page.getByRole('button', { name: 'Wyślij' }).click();
  await expect(page.locator('.msg-assistant').last()).toContainText('tryb demo', {
    timeout: 10_000,
  });
  await page.getByRole('button', { name: 'Odczytaj odpowiedź' }).last().click();
  await expect.poll(() => played(page)).toHaveLength(2);
  expect(bodies[1]).toEqual({ messageId: expect.stringMatching(/^[0-9a-f-]{36}$/) });

  await page.goto('/#/settings');
  const voice = page.locator('.voice-status');
  await expect(voice).toContainText('ElevenLabs');
  await expect(voice).toContainText('o2xdfKUpc1Bwq7RchZuW');
  await expect(voice).toContainText('120 z 30000 znaków');
});

test('ElevenLabs niedostępny (np. limit): czyta głos przeglądarki', async ({ page }) => {
  const bodies = await setup(page, 429);
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/home');
  await page
    .getByRole('region', { name: 'Przegląd dnia' })
    .getByRole('button', { name: 'Przeczytaj przegląd' })
    .click();
  await expect.poll(() => spoken(page)).toHaveLength(1);
  expect((await spoken(page))[0]).toMatch(/^(Dzień dobry|Dobry wieczór), Alfa\./);
  expect(await played(page)).toEqual([]);
  expect(bodies).toEqual([{ briefing: true }]);
});
