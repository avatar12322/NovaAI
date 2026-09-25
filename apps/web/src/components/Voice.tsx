import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

/**
 * Głos bez kosztów serwera: dyktowanie przez Web Speech API przeglądarki i odczyt przez speechSynthesis.
 * Dyktowanie wymaga jawnej zgody — w Chrome/Edge rozpoznawanie mowy odbywa się na serwerach dostawcy przeglądarki.
 */
interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const CONSENT_KEY = 'nova-voice-consent';

function hasConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}

export function DictationButton({ onText }: { onText: (text: string) => void }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<RecognitionLike | null>(null);
  const Ctor = recognitionCtor();
  useEffect(() => () => rec.current?.stop(), []);
  if (!Ctor) return null;

  const toggle = () => {
    if (listening) {
      rec.current?.stop();
      return;
    }
    if (!hasConsent()) {
      const ok = window.confirm(
        'Dyktowanie używa rozpoznawania mowy przeglądarki. W Chrome/Edge nagranie jest przetwarzane na serwerach dostawcy przeglądarki. Włączyć dyktowanie?',
      );
      if (!ok) return;
      try {
        localStorage.setItem(CONSENT_KEY, '1');
      } catch {
        /* zgoda tylko na tę sesję */
      }
    }
    const r = new Ctor();
    r.lang = 'pl-PL';
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e) => {
      const text = Array.from(e.results)
        .map((res) => res[0]?.transcript ?? '')
        .join(' ')
        .trim();
      if (text) onText(text);
    };
    r.onerror = (e) =>
      setError(e.error === 'not-allowed' ? 'Brak dostępu do mikrofonu' : 'Błąd rozpoznawania mowy');
    r.onend = () => setListening(false);
    rec.current = r;
    setError(null);
    setListening(true);
    r.start();
  };

  return (
    <button
      type="button"
      className={`btn ${listening ? 'btn-primary' : ''}`}
      onClick={toggle}
      aria-pressed={listening}
      aria-label={listening ? 'Zatrzymaj dyktowanie' : 'Dyktowanie głosowe'}
      title={error ?? (listening ? 'Słucham…' : 'Dyktuj')}
    >
      <Icon name="mic" />
    </button>
  );
}

export function SpeakButton({ text }: { text: string }) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const speak = () => {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pl-PL';
    window.speechSynthesis.speak(u);
  };
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={speak}
      aria-label="Odczytaj odpowiedź"
    >
      <Icon name="speaker" size={14} />
    </button>
  );
}
