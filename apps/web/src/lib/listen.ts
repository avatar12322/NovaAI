import { api, ApiError } from './api';
import { voiceStatus } from './speech';

/**
 * Rozpoznawanie mowy: najpierw bezpłatne rozpoznawanie przeglądarki (Web Speech API), a gdy przeglądarka go nie ma
 * albo jej usługa nie działa (np. Brave, Opera, Vivaldi, Firefox) — nagranie z mikrofonu rozpoznawane przez serwer
 * (ElevenLabs, o ile skonfigurowany). Oba sposoby mają ten sam interfejs, więc dyktowanie i rozmowa głosowa nie
 * muszą wiedzieć, który działa.
 */
export interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  start(): void;
  /** Koniec słuchania z rozpoznaniem tego, co już padło. */
  stop(): void;
  /** Przerwanie bez rozpoznawania. */
  abort(): void;
}

export type Engine = 'browser' | 'server';

type RecognitionCtor = new () => RecognitionLike;

export function browserRecognition(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Czy przeglądarka potrafi nagrać mikrofon (potrzebne do rozpoznawania przez serwer). */
function canRecord(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined' &&
    typeof AudioContext !== 'undefined'
  );
}

/** Rozpoznawanie przez serwer jest dostępne (klucz ElevenLabs na serwerze i nagrywanie w przeglądarce). */
export async function serverRecognition(): Promise<boolean> {
  return canRecord() && !!(await voiceStatus())?.stt;
}

/** Błędy usługi rozpoznawania przeglądarki, po których warto przejść na serwer (mikrofon działa). */
export const FALLBACK_CODES: ReadonlySet<string> = new Set([
  'network',
  'service-not-allowed',
  'language-not-supported',
]);

const BROKEN_KEY = 'nova-stt-browser-broken';

/** Po awarii usługi przeglądarki do końca sesji karty od razu używamy serwera. */
export function preferredEngine(): Engine | null {
  let broken = false;
  try {
    broken = sessionStorage.getItem(BROKEN_KEY) === '1';
  } catch {
    /* bez pamięci sesji — zawsze najpierw przeglądarka */
  }
  if (browserRecognition() && !broken) return 'browser';
  return canRecord() ? 'server' : browserRecognition() ? 'browser' : null;
}

export function markBrowserBroken(): void {
  try {
    sessionStorage.setItem(BROKEN_KEY, '1');
  } catch {
    /* jw. */
  }
}

const TRY_ELSEWHERE =
  'Użyj Chrome lub Edge albo ustaw ELEVENLABS_API_KEY na serwerze — wtedy NovaAI rozpozna mowę sama.';

/** Czytelny komunikat dla kodu błędu rozpoznawania (kody wg MDN SpeechRecognitionErrorEvent.error). */
export function recognitionErrorText(code: string, message?: string): string {
  switch (code) {
    case 'not-allowed':
      return 'Brak zgody na mikrofon. Zezwól na mikrofon dla tej strony (ikona przy adresie strony) i spróbuj ponownie.';
    case 'audio-capture':
      return 'Nie da się nagrać dźwięku: brak mikrofonu albo używa go inna aplikacja. W Windows sprawdź Ustawienia → Prywatność i zabezpieczenia → Mikrofon.';
    case 'network':
      return `Usługa rozpoznawania mowy tej przeglądarki nie odpowiada (Brave, Opera i Vivaldi jej nie mają; Chrome potrzebuje internetu). ${TRY_ELSEWHERE}`;
    case 'service-not-allowed':
      return `Przeglądarka blokuje usługę rozpoznawania mowy. ${TRY_ELSEWHERE}`;
    case 'language-not-supported':
      return `Przeglądarka nie rozpoznaje mowy po polsku. ${TRY_ELSEWHERE}`;
    case 'unsupported':
      return `Ta przeglądarka nie rozpoznaje mowy. ${TRY_ELSEWHERE}`;
    case 'no-speech':
      return 'Nic nie usłyszałem — spróbuj jeszcze raz.';
    case 'server':
      return message || 'Rozpoznawanie mowy przez serwer nie powiodło się.';
    default:
      return `Błąd rozpoznawania mowy (${code}).`;
  }
}

export function createRecognition(engine: Engine): RecognitionLike {
  const Ctor = engine === 'browser' ? browserRecognition() : null;
  const r = Ctor ? new Ctor() : new ServerRecognition();
  r.lang = 'pl-PL';
  r.interimResults = false;
  r.continuous = false;
  return r;
}

// ---------- Koniec wypowiedzi po poziomie dźwięku ----------

export type VadVerdict = 'listen' | 'end' | 'no-speech';

export interface VadOptions {
  /** Najniższy próg głośności (RMS próbek w zakresie -1…1). */
  minLevel?: number;
  /** Próg nigdy nie wyższy niż ten — głośna mowa jest wykryta nawet przy źle oszacowanym tle. */
  maxLevel?: number;
  /** Tyle ms głosu, zanim uznamy, że ktoś mówi (bez pojedynczych trzasków). */
  speechMs?: number;
  /** Tyle ms ciszy po mowie kończy wypowiedź. */
  silenceMs?: number;
  /** Bez mowy przez tyle ms — „nic nie słychać”. */
  noSpeechMs?: number;
  /** Najdłuższe nagranie. */
  maxMs?: number;
}

/**
 * Wykrywanie mowy i jej końca z poziomu dźwięku (bez wysyłania ciszy do usługi rozliczanej za długość nagrania).
 * Tło szacowane jako najcichszy poziom, powoli dostosowywany; próg = 3 × tło w granicach [minLevel, maxLevel].
 */
export function createVad({
  minLevel = 0.012,
  maxLevel = 0.04,
  speechMs = 150,
  silenceMs = 1200,
  noSpeechMs = 8000,
  maxMs = 30_000,
}: VadOptions = {}) {
  let floor: number | null = null;
  let voiced = 0;
  let heard = false;
  let lastVoice = 0;
  let last = 0;
  return {
    get heard() {
      return heard;
    },
    push(level: number, atMs: number): VadVerdict {
      const dt = Math.max(0, atMs - last);
      last = atMs;
      floor = floor === null ? level : Math.min(floor, level);
      const threshold = Math.min(maxLevel, Math.max(minLevel, floor * 3));
      if (level > threshold) {
        voiced += dt;
        lastVoice = atMs;
        if (voiced >= speechMs) heard = true;
      } else {
        floor += (level - floor) * 0.02; // tło może się zmienić — powolne dostosowanie
      }
      if (atMs >= maxMs) return heard ? 'end' : 'no-speech';
      if (heard && atMs - lastVoice >= silenceMs) return 'end';
      if (!heard && atMs >= noSpeechMs) return 'no-speech';
      return 'listen';
    },
  };
}

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  return Math.sqrt(sum / buf.length);
}

const RECORDER_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

/** Jeden kontekst audio na stronę — tworzony przy pierwszym kliknięciu (zasady autoodtwarzania). */
let sharedCtx: AudioContext | null = null;
function audioContext(): AudioContext {
  sharedCtx ??= new AudioContext();
  void sharedCtx.resume().catch(() => undefined);
  return sharedCtx;
}

/**
 * Nagranie jednej wypowiedzi i rozpoznanie jej przez serwer. Zachowanie jak rozpoznawanie przeglądarki:
 * `onresult` z tekstem, `onerror` (`no-speech`, `not-allowed`, `audio-capture`, `server`), na końcu zawsze `onend`.
 */
class ServerRecognition implements RecognitionLike {
  lang = 'pl-PL';
  interimResults = false;
  continuous = false;
  onresult: RecognitionLike['onresult'] = null;
  onend: RecognitionLike['onend'] = null;
  onerror: RecognitionLike['onerror'] = null;

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private chunks: Blob[] = [];
  private vad = createVad();
  private stopRequested = false;
  private cancelled = false;
  private ended = false;

  start(): void {
    if (!canRecord()) {
      this.fail('unsupported');
      return;
    }
    const ctx = audioContext(); // jeszcze w obsłudze kliknięcia
    void this.run(ctx);
  }

  stop(): void {
    this.stopRequested = true;
    this.finishRecording();
  }

  abort(): void {
    this.cancelled = true;
    this.stop();
  }

  private async run(ctx: AudioContext): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      this.fail(
        name === 'NotAllowedError' || name === 'SecurityError' ? 'not-allowed' : 'audio-capture',
      );
      return;
    }
    if (this.stopRequested) {
      this.cleanup();
      this.end();
      return;
    }
    const mimeType = RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    } catch {
      this.cleanup();
      this.fail('audio-capture');
      return;
    }
    this.recorder = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    recorder.onstop = () => void this.upload(recorder.mimeType || mimeType || 'audio/webm');
    recorder.start(250);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    this.source = ctx.createMediaStreamSource(this.stream);
    this.source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const t0 = performance.now();
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      if (this.vad.push(rms(buf), performance.now() - t0) !== 'listen') this.finishRecording();
    }, 50);
  }

  private finishRecording(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
  }

  private async upload(mimeType: string): Promise<void> {
    this.cleanup();
    if (this.cancelled) return this.end();
    if (!this.vad.heard) {
      this.onerror?.({ error: 'no-speech' });
      return this.end();
    }
    const audio = new Blob(this.chunks, { type: mimeType.split(';')[0] });
    try {
      const { text } = await api.stt(audio);
      if (!this.cancelled && text) this.onresult?.({ results: [[{ transcript: text }]] });
    } catch (e) {
      if (!this.cancelled)
        this.onerror?.({ error: 'server', message: e instanceof ApiError ? e.message : undefined });
    }
    this.end();
  }

  private cleanup(): void {
    clearInterval(this.timer);
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private fail(code: string): void {
    if (!this.cancelled) this.onerror?.({ error: code });
    this.end();
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.onend?.();
  }
}
