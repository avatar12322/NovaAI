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

/** Odczyt na głos trwa — sygnał dla „kuli” asystenta (animacja mówienia). */
const SPEAKING = 'nova:speaking';
const announce = (on: boolean) => window.dispatchEvent(new CustomEvent(SPEAKING, { detail: on }));

export function useSpeaking(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => setOn((e as CustomEvent<boolean>).detail === true);
    window.addEventListener(SPEAKING, handler);
    return () => window.removeEventListener(SPEAKING, handler);
  }, []);
  return on;
}

export function SpeakButton({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);
  // Przerwanie odczytu przy zamknięciu widoku (np. zmiana rozmowy).
  useEffect(
    () => () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        announce(false);
      }
    },
    [],
  );
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const toggle = () => {
    window.speechSynthesis.cancel();
    if (speaking) {
      setSpeaking(false);
      announce(false);
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pl-PL';
    const stop = () => {
      setSpeaking(false);
      announce(false);
    };
    u.onend = stop;
    u.onerror = stop;
    setSpeaking(true);
    announce(true);
    window.speechSynthesis.speak(u);
  };
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-sm${speaking ? ' speaking' : ''}`}
      onClick={toggle}
      aria-pressed={speaking}
      aria-label={speaking ? 'Zatrzymaj odczyt' : 'Odczytaj odpowiedź'}
    >
      {speaking ? (
        <span className="eq" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ) : (
        <Icon name="speaker" size={14} />
      )}
    </button>
  );
}
