import { expect, test, type Page } from '@playwright/test';
import { loginAs, newConversation, shot } from './helpers';

/**
 * Przeglądarka bez usługi rozpoznawania mowy (jak Brave, Opera, Vivaldi: błąd `network`). Rozpoznawanie przeglądarki
 * i odpowiedź `/api/stt` są atrapami (bez klucza i kosztów); mikrofon to generator tonu — nagrywanie (MediaRecorder)
 * i wykrywanie końca wypowiedzi działają naprawdę.
 */
type W = { __gum: number; __spoken: string[] };

async function setup(page: Page, { serverStt }: { serverStt: boolean }) {
  const uploads: Array<{ type: string; bytes: number }> = [];
  await page.addInitScript(() => {
    const w = window as unknown as W & Record<string, unknown>;
    w.__gum = 0;
    w.__spoken = [];
    localStorage.setItem('nova-voice-consent', '1');
    localStorage.setItem('nova-voice-consent-server', '1');
    class BrokenRecognition {
      lang = '';
      interimResults = false;
      continuous = false;
      onresult: unknown = null;
      onend: (() => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      start() {
        setTimeout(() => {
          this.onerror?.({ error: 'network' });
          this.onend?.();
        }, 50);
      }
      stop() {}
      abort() {}
    }
    w.SpeechRecognition = BrokenRecognition;
    w.webkitSpeechRecognition = BrokenRecognition;
    // „Mikrofon”: 0,8 s tonu, potem cisza.
    navigator.mediaDevices.getUserMedia = async () => {
      w.__gum++;
      const ctx = new AudioContext();
      await ctx.resume();
      const osc = ctx.createOscillator();
      osc.frequency.value = 220;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.5, ctx.currentTime);
      gain.gain.setValueAtTime(0, ctx.currentTime + 0.8);
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      osc.start();
      return dest.stream;
    };
    window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
      w.__spoken.push(u.text);
      setTimeout(() => u.onend?.(new Event('end') as SpeechSynthesisEvent), 100);
    };
    window.speechSynthesis.cancel = () => undefined;
  });
  await page.route('**/api/tts/status', (r) =>
    r.fulfill({
      json: {
        provider: null,
        voiceId: null,
        modelId: null,
        monthChars: 0,
        monthlyLimit: null,
        stt: serverStt
          ? {
              provider: 'elevenlabs',
              modelId: 'scribe_v2',
              monthMinutes: 3,
              monthlyLimitMinutes: 60,
            }
          : null,
      },
    }),
  );
  await page.route('**/api/stt', (r) => {
    const req = r.request();
    uploads.push({
      type: req.headers()['content-type'] ?? '',
      bytes: req.postDataBuffer()?.length ?? 0,
    });
    return r.fulfill({ json: { text: 'co pamiętasz?' } });
  });
  return uploads;
}

test('dyktowanie: usługa przeglądarki nie działa — nagranie rozpoznane przez serwer (ElevenLabs)', async ({
  page,
}) => {
  const uploads = await setup(page, { serverStt: true });
  await loginAs(page, 'Alfa (test)');
  await newConversation(page);
  await page.getByRole('button', { name: 'Dyktowanie głosowe' }).click();
  // Bez ponownego klikania: błąd przeglądarki → nagranie → koniec po ciszy → tekst w polu wiadomości.
  await expect(page.getByRole('button', { name: 'Zatrzymaj dyktowanie' })).toBeVisible();
  await expect(page.locator('#composer-input')).toHaveValue('co pamiętasz?', { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Dyktowanie głosowe' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.type).toMatch(/^audio\/(webm|ogg|mp4)/);
  expect(uploads[0]!.bytes).toBeGreaterThan(512);
  await expect(page.locator('.voice-note')).toHaveCount(0);

  // Rozmowa głosowa w tej samej karcie od razu używa serwera.
  await page.locator('#composer-input').fill('');
  await page.getByRole('button', { name: 'Rozmowa głosowa' }).click();
  await expect(page.locator('.msg-mine').last()).toContainText('co pamiętasz?', {
    timeout: 10_000,
  });
  await expect(page.locator('.msg-assistant').last()).toContainText('tryb demo', {
    timeout: 10_000,
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__spoken))
    .toEqual([expect.stringContaining('tryb demo')]);
  await page.locator('.voice-bar').getByRole('button', { name: 'Zakończ rozmowę' }).click();
  await expect(page.locator('.voice-bar')).toHaveCount(0);

  await page.goto('/#/settings');
  await expect(page.locator('.stt-status')).toContainText('zapasowo ElevenLabs');
  await expect(page.locator('.stt-status')).toContainText('3 z 60 min');
});

test('bez zapasu na serwerze: konkretna przyczyna i co zrobić zamiast „Błąd rozpoznawania mowy”', async ({
  page,
}) => {
  const uploads = await setup(page, { serverStt: false });
  await loginAs(page, 'Alfa (test)');
  await newConversation(page);
  await page.getByRole('button', { name: 'Dyktowanie głosowe' }).click();
  const note = page.locator('.voice-note');
  await expect(note).toContainText('Brave, Opera i Vivaldi');
  await expect(note).toContainText('Użyj Chrome lub Edge');
  await shot(page, '23-voice-error');
  await expect(page.getByRole('button', { name: 'Dyktowanie głosowe' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('button', { name: 'Rozmowa głosowa' }).click();
  await expect(note).toContainText('Brave, Opera i Vivaldi');
  await expect(page.locator('.voice-bar')).toHaveCount(0);
  expect(uploads).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as W).__gum)).toBe(0);
});
