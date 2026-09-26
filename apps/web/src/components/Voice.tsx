import { useEffect, useRef, useState } from 'react';
import { speak, stopSpeech, type SpeechSource } from '../lib/speech';
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

/** Jednorazowa zgoda na rozpoznawanie mowy przeglądarki (dyktowanie i rozmowa głosowa). */
function askVoiceConsent(): boolean {
  if (hasConsent()) return true;
  const ok = window.confirm(
    'Dyktowanie używa rozpoznawania mowy przeglądarki. W Chrome/Edge nagranie jest przetwarzane na serwerach dostawcy przeglądarki. Włączyć dyktowanie?',
  );
  if (!ok) return false;
  try {
    localStorage.setItem(CONSENT_KEY, '1');
  } catch {
    /* zgoda tylko na tę sesję */
  }
  return true;
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
    if (!askVoiceConsent()) return;
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

export function SpeakButton({
  text,
  label,
  source,
}: {
  text: string;
  label?: string;
  /** Źródło dla głosu z serwera (ElevenLabs); bez niego — głos przeglądarki. */
  source?: SpeechSource;
}) {
  const [speaking, setSpeaking] = useState(false);
  const active = useRef(false);
  // Przerwanie odczytu przy zamknięciu widoku (np. zmiana rozmowy).
  useEffect(
    () => () => {
      if (active.current) stopSpeech();
    },
    [],
  );
  if (typeof window === 'undefined' || !('speechSynthesis' in window || source)) return null;
  const toggle = () => {
    if (speaking) {
      stopSpeech();
      return;
    }
    active.current = true;
    setSpeaking(true);
    announce(true);
    void speak(text, source, () => {
      active.current = false;
      setSpeaking(false);
      announce(false);
    });
  };
  return (
    <button
      type="button"
      className={`btn ${label ? '' : 'btn-ghost '}btn-sm${speaking ? ' speaking' : ''}`}
      onClick={toggle}
      aria-pressed={speaking}
      aria-label={speaking ? 'Zatrzymaj odczyt' : (label ?? 'Odczytaj odpowiedź')}
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
      {label && <span>{speaking ? 'Zatrzymaj' : label}</span>}
    </button>
  );
}

/** Tekst do odczytu: bez znaczników Markdown i odnośników do źródeł ([D1]). */
export function speakable(text: string): string {
  return text
    .replace(/\[D\d+\]/g, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type VoiceState = 'off' | 'listening' | 'waiting' | 'speaking';

const NO_SPEECH_LIMIT = 3;

/**
 * Rozmowa głosowa bez rąk: słuchaj → wyślij → (odpowiedź) → odczytaj → słuchaj znowu, aż do „Zakończ”.
 * Rozpoznawanie mowy przeglądarki (za zgodą) i speechSynthesis — bez kosztów serwera. Cisza kilka razy z rzędu
 * albo błąd mikrofonu kończy rozmowę.
 */
export function useVoiceConversation(onUtterance: (text: string) => void) {
  const [state, setState] = useState<VoiceState>('off');
  const [error, setError] = useState<string | null>(null);
  const cb = useRef(onUtterance);
  cb.current = onUtterance;
  // Sterownik w ref: stabilne funkcje, bez zależności między callbackami.
  const ctl = useRef<{
    active: boolean;
    rec: RecognitionLike | null;
    silent: number;
    listen(): void;
    stop(message?: string): void;
  } | null>(null);
  if (!ctl.current) {
    const c = {
      active: false,
      rec: null as RecognitionLike | null,
      silent: 0,
      listen() {
        const Ctor = recognitionCtor();
        if (!c.active || !Ctor) return;
        const r = new Ctor();
        r.lang = 'pl-PL';
        r.interimResults = false;
        r.continuous = false;
        let heard = false;
        r.onresult = (e) => {
          const text = Array.from(e.results)
            .map((res) => res[0]?.transcript ?? '')
            .join(' ')
            .trim();
          if (!text || !c.active) return;
          heard = true;
          c.silent = 0;
          setState('waiting');
          cb.current(text);
        };
        r.onerror = (e) => {
          if (e.error === 'no-speech' || e.error === 'aborted') return;
          c.stop(
            e.error === 'not-allowed' ? 'Brak dostępu do mikrofonu' : 'Błąd rozpoznawania mowy',
          );
        };
        r.onend = () => {
          if (c.rec === r) c.rec = null;
          if (!c.active || heard) return;
          if (++c.silent > NO_SPEECH_LIMIT) c.stop('Nic nie słychać — rozmowa głosowa zakończona.');
          else c.listen();
        };
        c.rec = r;
        setState('listening');
        r.start();
      },
      stop(message?: string) {
        c.active = false;
        c.rec?.stop();
        c.rec = null;
        stopSpeech();
        announce(false);
        setState('off');
        setError(message ?? null);
      },
    };
    ctl.current = c;
  }
  useEffect(() => {
    const c = ctl.current!;
    return () => {
      if (c.active) c.stop();
    };
  }, []);

  const supported =
    typeof window !== 'undefined' && recognitionCtor() !== null && 'speechSynthesis' in window;
  return {
    supported,
    state,
    error,
    start() {
      const c = ctl.current!;
      if (!supported || c.active || !askVoiceConsent()) return;
      setError(null);
      c.active = true;
      c.silent = 0;
      c.listen();
    },
    stop() {
      ctl.current!.stop();
    },
    /** Odczyt odpowiedzi (głos z serwera, gdy znane źródło), potem znowu słuchanie (o ile rozmowa trwa). */
    speak(text: string, source?: SpeechSource) {
      const c = ctl.current!;
      if (!c.active) return;
      setState('speaking');
      announce(true);
      void speak(speakable(text) || 'Gotowe.', source, () => {
        announce(false);
        if (c.active) c.listen();
      });
    },
  };
}

/** Odczyt spoza przycisku (np. z palety poleceń) — z sygnałem „mówi” dla kuli asystenta. */
export function speakNow(text: string, source?: SpeechSource): void {
  announce(true);
  void speak(text, source, () => announce(false));
}
