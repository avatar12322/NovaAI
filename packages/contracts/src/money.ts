/**
 * Kwoty i waluty modułu „Usługi i koszty” — bez zależności od zod (moduł używany także w przeglądarce).
 * Kwoty są liczbami całkowitymi w mikro-jednostkach waluty (1 PLN = 1 000 000), jak w usage_records:
 * sumowanie bez błędów zmiennoprzecinkowych. Różnych walut nigdy nie sumujemy ze sobą.
 */
export const MICROS = 1_000_000;

/** Tekst kwoty: „12”, „12.34”, „12,34” (maks. 9 cyfr całości i 6 po przecinku, bez znaku). */
export const AMOUNT_RE = /^\d{1,9}([.,]\d{1,6})?$/;

export function parseAmountMicros(text: string): number | null {
  const t = text.trim().replace(/\s/g, '');
  if (!AMOUNT_RE.test(t)) return null;
  const [int, frac = ''] = t.split(/[.,]/);
  return Number(int) * MICROS + Number(frac.padEnd(6, '0'));
}

/** Mikro-jednostki → tekst dziesiętny bez zer na końcu („12.5”) — do formularzy. */
export function microsToText(micros: number): string {
  const int = Math.floor(micros / MICROS);
  const frac = String(micros % MICROS)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return frac ? `${int}.${frac}` : String(int);
}

let currencies: Set<string> | null = null;
/** Kod waluty ISO 4217 znany środowisku (Intl). */
export function isCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    currencies ??= new Set(Intl.supportedValuesOf('currency'));
    return currencies.has(code);
  } catch {
    return true;
  }
}

/** Liczba miejsc po przecinku waluty (PLN 2, JPY 0). */
export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export function formatMicros(micros: number, currency: string, locale = 'pl-PL'): string {
  const digits = currencyDigits(currency);
  // Drobne kwoty (np. ułamki centa z raportu dostawcy) pokazujemy z większą dokładnością, żeby nie znikały.
  const small = micros > 0 && micros < 10 ** (6 - digits);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: small ? 6 : digits,
  }).format(micros / MICROS);
}

/**
 * Tekst wyglądający na sekret (klucz API, token, hasło). Moduł nie przechowuje haseł ani kluczy —
 * takie pola odrzucamy z czytelnym komunikatem zamiast zapisać je przypadkiem.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|proj-|admin)?[A-Za-z0-9_-]{16,}/,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pwd|hasło|haslo|secret|token|api[_-]?key)\s*[:=]\s*\S{4,}/i,
];
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

const SECRET_PARAM = /^(?:.*_)?(?:token|key|secret|password|passwd|pwd|auth|signature|sig|code)$/i;
/** Link do panelu: tylko HTTPS, bez danych logowania w adresie i bez parametrów wyglądających na sekrety. */
export function safePanelUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  for (const k of u.searchParams.keys()) if (SECRET_PARAM.test(k)) return null;
  if (looksLikeSecret(u.toString())) return null;
  return u.toString();
}

/** Pierwszy dzień miesiąca „YYYY-MM” → „YYYY-MM-01”. */
export const monthStart = (month: string) => `${month}-01`;

/** Bieżący miesiąc UTC („YYYY-MM”) — raporty dostawców liczą dni w UTC. */
export const currentMonth = (now = new Date()) => now.toISOString().slice(0, 7);
