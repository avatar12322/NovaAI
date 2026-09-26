/**
 * ElevenLabs (dokumentacja sprawdzona 2026-09-26). Klucz wyłącznie po stronie serwera; treść odpowiedzi błędu
 * nie jest przekazywana dalej.
 * - Synteza mowy: `POST {base}/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128`, nagłówek `xi-api-key`,
 *   ciało `{ text, model_id }` → MP3. Model domyślny `eleven_flash_v2_5` (polski, najniższe opóźnienie).
 * - Rozpoznawanie mowy: `POST {base}/v1/speech-to-text`, `multipart/form-data` z `file`, `model_id`
 *   (domyślnie `scribe_v2`; `scribe_v1` przestarzały) i `language_code` → `{ text, audio_duration_secs, … }`.
 *   Rozliczane za długość nagrania.
 */
export class TtsError extends Error {
  constructor(
    public readonly code: 'rejected' | 'quota' | 'unavailable' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

export interface TtsOptions {
  apiKey: string;
  voiceId: string;
  modelId: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class ElevenLabsTts {
  constructor(private readonly opts: TtsOptions) {}

  get voiceId(): string {
    return this.opts.voiceId;
  }
  get modelId(): string {
    return this.opts.modelId;
  }

  async synthesize(text: string): Promise<Buffer> {
    const base = (this.opts.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/+$/, '');
    let res: Response;
    try {
      res = await fetch(
        `${base}/v1/text-to-speech/${encodeURIComponent(this.opts.voiceId)}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
          headers: {
            'xi-api-key': this.opts.apiKey,
            'content-type': 'application/json',
            accept: 'audio/mpeg',
          },
          body: JSON.stringify({ text, model_id: this.opts.modelId }),
        },
      );
    } catch {
      throw new TtsError('unavailable', 'ElevenLabs nie odpowiada — spróbuj później');
    }
    if (!res.ok) throw await httpError(res, 'sprawdź głos i model');
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Błąd HTTP ElevenLabs jako `TtsError` — bez treści odpowiedzi (może zawierać szczegóły konta). */
async function httpError(res: Response, invalidHint: string): Promise<TtsError> {
  await res.body?.cancel();
  if (res.status === 401 || res.status === 403)
    return new TtsError('rejected', `ElevenLabs odrzucił klucz (HTTP ${res.status})`);
  if (res.status === 429)
    return new TtsError('quota', 'ElevenLabs: limit zapytań lub limit w planie — spróbuj później');
  if (res.status === 422 || res.status === 400)
    return new TtsError(
      'invalid',
      `ElevenLabs odrzucił żądanie (HTTP ${res.status}) — ${invalidHint}`,
    );
  return new TtsError('unavailable', `ElevenLabs zwrócił błąd HTTP ${res.status}`);
}

export interface SttOptions {
  apiKey: string;
  modelId: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface Transcript {
  text: string;
  /** Długość nagrania wg ElevenLabs (podstawa rozliczenia); null, gdy odpowiedź jej nie podaje. */
  seconds: number | null;
}

export class ElevenLabsStt {
  constructor(private readonly opts: SttOptions) {}

  get modelId(): string {
    return this.opts.modelId;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<Transcript> {
    const base = (this.opts.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/+$/, '');
    const form = new FormData();
    form.set('model_id', this.opts.modelId);
    form.set('language_code', 'pol');
    form.set('tag_audio_events', 'false');
    form.set('file', new Blob([new Uint8Array(audio)], { type: mimeType }), 'nagranie');
    let res: Response;
    try {
      res = await fetch(`${base}/v1/speech-to-text`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        headers: { 'xi-api-key': this.opts.apiKey, accept: 'application/json' },
        body: form,
      });
    } catch {
      throw new TtsError('unavailable', 'ElevenLabs nie odpowiada — spróbuj później');
    }
    if (!res.ok) throw await httpError(res, 'nagranie nieczytelne albo zły model');
    const data = (await res.json().catch(() => null)) as {
      text?: unknown;
      audio_duration_secs?: unknown;
    } | null;
    if (!data || typeof data.text !== 'string')
      throw new TtsError('unavailable', 'ElevenLabs zwrócił nieoczekiwaną odpowiedź');
    const secs = data.audio_duration_secs;
    return {
      text: data.text.trim(),
      seconds: typeof secs === 'number' && Number.isFinite(secs) && secs >= 0 ? secs : null,
    };
  }
}
