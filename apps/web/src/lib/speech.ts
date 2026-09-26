import { api, type VoiceStatus } from './api';

/**
 * Jeden odtwarzacz mowy dla całej aplikacji: głos ElevenLabs z serwera (gdy skonfigurowany i znane jest źródło —
 * odpowiedź asystenta albo przegląd dnia), w przeciwnym razie albo po błędzie — głos przeglądarki.
 * Naraz mówi tylko jedna rzecz; zatrzymanie działa także w trakcie pobierania dźwięku.
 */
export type SpeechSource = { messageId: string } | { briefing: true };

let status: Promise<VoiceStatus | null> | null = null;
/** Głos z serwera (synteza i rozpoznawanie mowy) — sprawdzany raz na sesję strony. */
export function voiceStatus(): Promise<VoiceStatus | null> {
  status ??= api.ttsStatus().catch(() => null);
  return status;
}

/** Czy serwer ma głos ElevenLabs do odczytu. */
function serverVoice(): Promise<boolean> {
  return voiceStatus().then((s) => s?.provider === 'elevenlabs');
}

let seq = 0;
let current: (() => void) | null = null;

export function stopSpeech(): void {
  seq++;
  const stop = current;
  current = null;
  stop?.();
}

function browserVoice(text: string, done: () => void): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    done();
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pl-PL';
  u.onend = done;
  u.onerror = done;
  current = () => {
    window.speechSynthesis.cancel();
    done();
  };
  window.speechSynthesis.speak(u);
}

/** Mówi tekst; `onEnd` wywoływane dokładnie raz (koniec, błąd albo zatrzymanie). */
export async function speak(
  text: string,
  source: SpeechSource | undefined,
  onEnd: () => void,
): Promise<void> {
  stopSpeech();
  const token = ++seq;
  let ended = false;
  const done = () => {
    if (ended) return;
    ended = true;
    if (token === seq) current = null;
    onEnd();
  };
  current = done; // zatrzymanie w trakcie pobierania też kończy odczyt
  if (source && (await serverVoice())) {
    try {
      const blob = await api.tts(source);
      if (token !== seq) return; // zatrzymano w międzyczasie
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      const release = () => URL.revokeObjectURL(url);
      let fellBack = false;
      // Plik nie do odtworzenia albo blokada odtwarzania — głos przeglądarki zamiast ciszy.
      const fallback = () => {
        release();
        if (fellBack || ended || token !== seq) return;
        fellBack = true;
        browserVoice(text, done);
      };
      audio.onended = () => {
        release();
        done();
      };
      audio.onerror = fallback;
      current = () => {
        audio.pause();
        release();
        done();
      };
      await audio.play().catch(fallback);
      return;
    } catch {
      if (token !== seq) return;
      // Brak klucza, limit albo błąd sieci — głos przeglądarki.
    }
  }
  if (token === seq) browserVoice(text, done);
}
