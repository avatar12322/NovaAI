import { expect, test } from '@playwright/test';
import { loginAs, shot, newConversation } from './helpers';

/**
 * Rozmowa głosowa bez rąk: słuchanie → wysłanie rozpoznanej wypowiedzi → odpowiedź odczytana na głos → znowu
 * słuchanie → zakończenie. Rozpoznawanie i synteza mowy są atrapami (bez mikrofonu i bez usług przeglądarki).
 */
test('rozmowa głosowa: mówię, asystent odpowiada na głos i słucha dalej', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown> & {
      __spoken: string[];
      __recStarts: number;
    };
    localStorage.setItem('nova-voice-consent', '1');
    w.__spoken = [];
    w.__recStarts = 0;
    const phrases = ['co pamiętasz?'];
    class FakeRecognition {
      lang = '';
      interimResults = false;
      continuous = false;
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      start() {
        w.__recStarts++;
        const text = phrases.shift();
        // Pierwsze słuchanie „słyszy” pytanie; kolejne czeka (jak cisza przed następnym pytaniem).
        if (text)
          setTimeout(() => {
            this.onresult?.({ results: [[{ transcript: text }]] });
            this.onend?.();
          }, 200);
      }
      stop() {
        setTimeout(() => this.onend?.(), 0);
      }
    }
    w.SpeechRecognition = FakeRecognition;
    w.webkitSpeechRecognition = FakeRecognition;
    window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
      w.__spoken.push(u.text);
      setTimeout(() => u.onend?.(new Event('end') as SpeechSynthesisEvent), 300);
    };
    window.speechSynthesis.cancel = () => undefined;
  });
  await loginAs(page, 'Alfa (test)');
  await newConversation(page);

  await page.getByRole('button', { name: 'Rozmowa głosowa' }).click();
  const bar = page.locator('.voice-bar');
  await expect(bar).toBeVisible();
  // Rozpoznane pytanie trafia do rozmowy bez klikania „Wyślij”.
  await expect(page.locator('.msg-mine').last()).toContainText('co pamiętasz?');
  await expect(page.locator('.msg-assistant').last()).toContainText('tryb demo', {
    timeout: 10_000,
  });
  // Odpowiedź tej tury jest odczytana na głos, potem asystent znowu słucha.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken))
    .toEqual([expect.stringContaining('tryb demo')]);
  await expect(bar).toContainText('Słucham');
  await expect(page.locator('.conv-head .orb')).toHaveClass(/orb-listening/);
  expect(
    await page.evaluate(() => (window as unknown as { __recStarts: number }).__recStarts),
  ).toBeGreaterThanOrEqual(2);
  await shot(page, '20-voice-conversation');

  await bar.getByRole('button', { name: 'Zakończ rozmowę' }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.locator('.conv-head .orb')).toHaveClass(/orb-idle/);
  await expect(page.getByRole('button', { name: 'Rozmowa głosowa' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
