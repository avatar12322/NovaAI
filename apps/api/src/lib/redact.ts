/**
 * Redakcja danych przed zapisem do logów/audytu/zdarzeń.
 * Klucze wyglądające na sekrety są zastępowane; długie teksty skracane.
 */
const SECRET_KEY =
  /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|otp|code_verifier/i;
const CONTENT_KEY = /^(content|body|text|message|diff|html|snippet)$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string')
    return value.length > 200 ? `${value.slice(0, 200)}…[${value.length}]` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) out[k] = '[redacted]';
    else if (CONTENT_KEY.test(k) && typeof v === 'string') out[k] = `[${v.length} chars]`;
    else out[k] = redact(v, depth + 1);
  }
  return out;
}

/** Nagłówki/ścieżki logowane przez Fastify — bez ciasteczek i autoryzacji. */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-device-token"]',
  'res.headers["set-cookie"]',
];
