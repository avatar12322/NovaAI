import { useEffect, useRef, useState } from 'react';
import {
  browserRecognition,
  createRecognition,
  FALLBACK_CODES,
  markBrowserBroken,
  preferredEngine,
  recognitionErrorText,
  serverRecognition,
  type Engine,
  type RecognitionLike,
} from '../lib/listen';
import { speak, stopSpeech, type SpeechSource } from '../lib/speech';
import { Icon } from './Icon';

/**
 * Głos: dyktowanie i rozmowa głosowa. Rozpoznawanie mowy przeglądarki (bez kosztów), a gdy przeglądarka go nie ma
 * albo jej usługa nie działa — nagranie rozpoznane przez serwer (ElevenLabs). Każdy sposób wymaga jawnej zgody,
 * bo w obu nagranie trafia do zewnętrznej usługi. Odczyt: ElevenLabs albo speechSynthesis przeglądarki.
 */
const CONSENT: Record<Engine, { key: string; text: string }> = {
  browser: {
    key: 'nova-voice-consent',
    text: 'Rozpoznawanie mowy używa usługi przeglądarki. W Chrome/Edge nagranie jest przetwarzane na serwerach dostawcy przeglądarki. Włączyć?',
  },
  server: {
    key: 'nova-voice-consent-server',
    text: 'Ta przeglądarka nie rozpoznaje mowy sama. NovaAI może wysłać krótkie nagranie (do 30 s) przez swój serwer do ElevenLabs — rozliczane w planie ElevenLabs, w miesięcznym limicie minut domu. NovaAI nie zapisuje nagrania. Włączyć?',
  },
};

/** Jednorazowa zgoda na dany sposób rozpoznawania mowy (dyktowanie i rozmowa głosowa). */
function askVoiceConsent(engine: Engine): boolean {
  const { key, text } = CONSENT[engine];
  try {
    if (localStorage.getItem(key) === '1') return true;
  } catch {
    /* bez pamięci — pytamy za każdym razem */
  }
  if (!window.confirm(text)) return false;
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* zgoda tylko na tę sesję */
  }
  return true;
}

const transcript = (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) =>
  Array.from(e.results)
    .map((res) => res[0]?.transcript ?? '')
    .join(' ')
    .trim();

/** Czy da się słuchać: rozpoznawanie przeglądarki albo przez serwer (sprawdzane po stanie serwera). */
function useListening(): boolean {
  const [server, setServer] = useState(false);
  useEffect(() => {
    let on = true;
    void serverRecognition().then((ok) => on && setServer(ok));
    return () => {
      on = false;
    };
  }, []);
  return browserRecognition() !== null || server;
}

/** Sposób rozpoznawania na start albo komunikat, dlaczego się nie da. */
async function startEngine(): Promise<Engine | { error: string }> {
  const engine = preferredEngine();
  if (engine === 'server' && !(await serverRecognition()))
    return { error: recognitionErrorText(browserRecognition() ? 'network' : 'unsupported') };
  return engine ?? { error: recognitionErrorText('unsupported') };
}

export function DictationButton({
  onText,
  onError,
}: {
  onText: (text: string) => void;
  /** Komunikat błędu do pokazania przy polu wiadomości (null — wyczyść). */
  onError: (message: string | null) => void;
}) {
  const [listening, setListening] = useState(false);
  const rec = useRef<RecognitionLike | null>(null);
  const available = useListening();
  useEffect(() => () => rec.current?.abort(), []);
  if (!available) return null;

  const begin = (engine: Engine) => {
    if (!askVoiceConsent(engine)) {
      setListening(false);
      return;
    }
    const r = createRecognition(engine);
    let fellBack = false;
    r.onresult = (e) => {
      const text = transcript(e);
      if (text) onText(text);
    };
    r.onerror = (e) => {
      if (e.error === 'aborted') return;
      if (engine === 'browser' && FALLBACK_CODES.has(e.error)) {
        // Usługa przeglądarki nie działa — to samo nagranie przez serwer, bez ponownego klikania.
        fellBack = true;
        void serverRecognition().then((ok) => {
          if (ok) {
            markBrowserBroken();
            begin('server');
          } else {
            setListening(false);
            onError(recognitionErrorText(e.error));
          }
        });
        return;
      }
      onError(recognitionErrorText(e.error, e.message));
    };
    r.onend = () => {
      if (rec.current === r) rec.current = null;
      if (!fellBack) setListening(false);
    };
    rec.current = r;
    onError(null);
    setListening(true);
    r.start();
  };

  const toggle = async () => {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const engine = await startEngine();
    if (typeof engine === 'object') onError(engine.error);
    else begin(engine);
  };

  return (
    <button
      type="button"
      className={`btn ${listening ? 'btn-primary' : ''}`}
      onClick={() => void toggle()}
      aria-pressed={listening}
      aria-label={listening ? 'Zatrzymaj dyktowanie' : 'Dyktowanie głosowe'}
      title={listening ? 'Słucham…' : 'Dyktuj'}
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
 * Cisza kilka razy z rzędu albo błąd mikrofonu kończy rozmowę; awaria usługi rozpoznawania przeglądarki
 * przełącza na rozpoznawanie przez serwer (gdy dostępne).
 */
export function useVoiceConversation(onUtterance: (text: string) => void) {
  const [state, setState] = useState<VoiceState>('off');
  const [error, setError] = useState<string | null>(null);
  const listening = useListening();
  const cb = useRef(onUtterance);
  cb.current = onUtterance;
  // Sterownik w ref: stabilne funkcje, bez zależności między callbackami.
  const ctl = useRef<{
    active: boolean;
    engine: Engine;
    rec: RecognitionLike | null;
    silent: number;
    listen(): void;
    stop(message?: string): void;
  } | null>(null);
  if (!ctl.current) {
    const c = {
      active: false,
      engine: 'browser' as Engine,
      rec: null as RecognitionLike | null,
      silent: 0,
      listen() {
        if (!c.active) return;
        const r = createRecognition(c.engine);
        let heard = false;
        let fellBack = false;
        r.onresult = (e) => {
          const text = transcript(e);
          if (!text || !c.active) return;
          heard = true;
          c.silent = 0;
          setState('waiting');
          cb.current(text);
        };
        r.onerror = (e) => {
          if (e.error === 'no-speech' || e.error === 'aborted') return;
          if (c.engine === 'browser' && FALLBACK_CODES.has(e.error)) {
            fellBack = true;
            void serverRecognition().then((ok) => {
              if (!c.active) return;
              if (ok && askVoiceConsent('server')) {
                markBrowserBroken();
                c.engine = 'server';
                c.listen();
              } else c.stop(recognitionErrorText(e.error));
            });
            return;
          }
          c.stop(recognitionErrorText(e.error, e.message));
        };
        r.onend = () => {
          if (c.rec === r) c.rec = null;
          if (!c.active || heard || fellBack) return;
          if (++c.silent > NO_SPEECH_LIMIT) c.stop('Nic nie słychać — rozmowa głosowa zakończona.');
          else c.listen();
        };
        c.rec = r;
        setState('listening');
        r.start();
      },
      stop(message?: string) {
        c.active = false;
        c.rec?.abort();
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

  const supported = listening && typeof window !== 'undefined' && 'speechSynthesis' in window;
  return {
    supported,
    state,
    error,
    async start() {
      const c = ctl.current!;
      if (!supported || c.active) return;
      const engine = await startEngine();
      if (typeof engine === 'object') {
        setError(engine.error);
        return;
      }
      if (!askVoiceConsent(engine)) return;
      setError(null);
      c.active = true;
      c.engine = engine;
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
