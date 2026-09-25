/**
 * Prosty limiter okna przesuwnego w pamięci procesu (jedna instancja API — patrz DECISIONS).
 * Chroni nieuwierzytelnione trasy przed zalewem (tworzenie wyzwań, parowanie, enrolment).
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Rejestruje trafienie; zwraca false, gdy limit przekroczony. */
  hit(key: string, now = Date.now()): boolean {
    this.sweep(now);
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [k, arr] of this.hits) {
      if (!arr.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    }
  }
}

/** Usuwa wrażliwe parametry z URL do logów (kody OAuth, state, tokeny). */
export function redactUrl(url: string): string {
  const i = url.indexOf('?');
  if (i < 0) return url;
  const params = new URLSearchParams(url.slice(i + 1));
  for (const k of [...params.keys()]) {
    if (/^(code|state|token|access_token|refresh_token|id_token|key|secret|sig)$/i.test(k))
      params.set(k, '[redacted]');
  }
  return `${url.slice(0, i)}?${params.toString()}`;
}
