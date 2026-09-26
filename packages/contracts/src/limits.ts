/**
 * Limity wspólne dla API i UI. Moduł bez zależności (bez zod) — frontend importuje go przez
 * `@nova/contracts/limits`, aby nie dołączać zod do bundla (zod sprawdza `Function('')`, co łamie CSP).
 */
export const LIMITS = {
  messageChars: 16_000,
  memoryChars: 4_000,
  titleChars: 200,
  bodyBytes: 256 * 1024,
} as const;
