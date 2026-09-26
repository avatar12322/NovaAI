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

/** Pamięć dokumentów: limity widoczne też w UI (przed wysłaniem pliku). */
export const DOCUMENT_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxDocumentsPerUser: 200,
  maxTotalBytesPerUser: 200 * 1024 * 1024,
  maxPages: 500,
  maxChars: 2_000_000,
  extensions: ['.pdf', '.txt', '.md', '.markdown'],
} as const;
