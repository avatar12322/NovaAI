/**
 * Synteza mowy ElevenLabs (dokumentacja sprawdzona 2026-09-26): `POST {base}/v1/text-to-speech/{voice_id}`
 * z nagłówkiem `xi-api-key`, ciało `{ text, model_id }`, `output_format=mp3_44100_128` → plik MP3.
 * Model domyślny `eleven_flash_v2_5` (obsługuje polski, najniższe opóźnienie, połowa kosztu znaku).
 * Klucz wyłącznie po stronie serwera; treść odpowiedzi błędu nie jest przekazywana dalej.
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
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401 || res.status === 403)
        throw new TtsError('rejected', `ElevenLabs odrzucił klucz (HTTP ${res.status})`);
      if (res.status === 429)
        throw new TtsError(
          'quota',
          'ElevenLabs: limit zapytań lub znaków w planie — spróbuj później',
        );
      if (res.status === 422 || res.status === 400)
        throw new TtsError(
          'invalid',
          `ElevenLabs odrzucił żądanie (HTTP ${res.status}) — sprawdź głos i model`,
        );
      throw new TtsError('unavailable', `ElevenLabs zwrócił błąd HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
