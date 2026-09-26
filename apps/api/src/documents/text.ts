import type { DocumentFormat, SnippetSegment } from '@nova/contracts';

/** Błąd odczytu/walidacji dokumentu z komunikatem dla użytkownika (bez szczegółów technicznych). */
export class DocumentError extends Error {
  constructor(
    public readonly code:
      | 'unsupported_format'
      | 'empty'
      | 'too_large'
      | 'binary'
      | 'invalid_pdf'
      | 'encrypted'
      | 'no_text'
      | 'too_many_pages'
      | 'too_much_text'
      | 'timeout'
      | 'too_complex',
    message: string,
  ) {
    super(message);
  }
}

/** Małe litery, bez znaków diakrytycznych (ł → l) — ten sam proces dla treści i zapytań. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
}

/** Bezpieczna nazwa pliku: bez ścieżki i znaków sterujących. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, 255);
}

export function titleFromFilename(filename: string): string {
  const t = filename.replace(/\.(pdf|txt|md|markdown)$/i, '').trim();
  return (t || filename).slice(0, 200);
}

/**
 * Format z rozszerzenia, potwierdzony zawartością (nie ufamy typowi MIME od klienta).
 * PDF musi zaczynać się sygnaturą `%PDF-` (w pierwszym kilobajcie, zgodnie ze specyfikacją).
 */
export function detectFormat(filename: string, bytes: Buffer): DocumentFormat {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  const format: DocumentFormat | null =
    ext === 'pdf'
      ? 'pdf'
      : ext === 'txt'
        ? 'txt'
        : ext === 'md' || ext === 'markdown'
          ? 'md'
          : null;
  if (!format) {
    throw new DocumentError(
      'unsupported_format',
      'Nieobsługiwany format — dodaj plik PDF, TXT lub Markdown (.md)',
    );
  }
  const head = bytes.subarray(0, 1024).toString('latin1');
  if (format === 'pdf' && !head.includes('%PDF-')) {
    throw new DocumentError(
      'invalid_pdf',
      'Plik ma rozszerzenie .pdf, ale nie jest dokumentem PDF',
    );
  }
  if (format !== 'pdf' && head.startsWith('%PDF-')) {
    throw new DocumentError('binary', 'To jest plik PDF — zmień rozszerzenie na .pdf');
  }
  return format;
}

/**
 * Tekst z pliku TXT/Markdown: UTF-8 (BOM usuwany), a gdy to niepoprawny UTF-8 — Windows-1250
 * (częste w starszych polskich plikach). Bajty zerowe oznaczają plik binarny.
 */
export function decodeText(bytes: Buffer): { text: string; encoding: 'utf-8' | 'windows-1250' } {
  if (bytes.includes(0)) {
    throw new DocumentError('binary', 'Plik wygląda na binarny — to nie jest zwykły tekst');
  }
  let text: string;
  let encoding: 'utf-8' | 'windows-1250' = 'utf-8';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1250').decode(bytes);
    encoding = 'windows-1250';
  }
  text = text.replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new DocumentError('empty', 'Plik nie zawiera tekstu');
  return { text, encoding };
}

const STOPWORDS = new Set(
  (
    'a aby ale albo bez bo by byc byl byla bylo byly co czy dla do gdy gdzie i ich ile im in ' +
    'ja jak jaka jaki jakie jako je jego jej jest jestem jeszcze jesli juz ktora ktore ktory ' +
    'kiedy lub ma mam mi mnie moja moj moje moze na nad nam nas nie niz no o od oraz po pod ' +
    'przez przy sa sie sa sobie ta tak takze tam te tego tej ten to tu ty tylko w we wiec ' +
    'wszystko z za ze zeby the of and or to in is are what how when'
  ).split(' '),
);

/**
 * Termy zapytania: znormalizowane słowa bez słów funkcyjnych, przycięte o typowe polskie końcówki
 * (dopasowanie prefiksowe) — „umowy”, „umowie”, „umową” trafiają w „umowa”. Liczby dopasowujemy dokładnie.
 */
export function queryTerms(q: string, max = 12): Array<{ stem: string; prefix: boolean }> {
  const out = new Map<string, boolean>();
  for (const w of normalize(q).split(/[^\p{L}\p{N}]+/u)) {
    if (!w || STOPWORDS.has(w)) continue;
    if (/^\p{N}+$/u.test(w)) {
      out.set(w, false);
    } else if (w.length >= 3) {
      const len = w.length;
      const stem = len <= 3 ? w : len <= 5 ? w.slice(0, len - 1) : w.slice(0, Math.max(5, len - 2));
      out.set(stem, len > 3);
    }
    if (out.size >= max) break;
  }
  return [...out].map(([stem, prefix]) => ({ stem, prefix }));
}

/** Zapytanie tsquery (OR) z termów; termy zawierają wyłącznie litery/cyfry, więc są bezpieczne. */
export function toTsQuery(terms: Array<{ stem: string; prefix: boolean }>): string {
  return terms.map((t) => (t.prefix ? `${t.stem}:*` : t.stem)).join(' | ');
}

const matchesTerm = (word: string, terms: Array<{ stem: string; prefix: boolean }>) => {
  const n = normalize(word);
  return terms.some((t) => (t.prefix ? n.startsWith(t.stem) : n === t.stem));
};

/**
 * Wycinek tekstu wokół pierwszego trafienia (~`width` znaków) z zaznaczonymi trafieniami.
 * Zwraca segmenty (tekst + flaga), więc UI nie musi interpretować HTML.
 */
export function snippet(
  content: string,
  terms: Array<{ stem: string; prefix: boolean }>,
  width = 320,
): SnippetSegment[] {
  const text = plainText(content);
  const tokens = text.split(/([\p{L}\p{N}]+)/u);
  let pos = 0;
  let firstHit = -1;
  for (const tok of tokens) {
    if (tok && /[\p{L}\p{N}]/u.test(tok) && matchesTerm(tok, terms)) {
      firstHit = pos;
      break;
    }
    pos += tok.length;
  }
  let start = firstHit < 0 ? 0 : Math.max(0, firstHit - Math.floor(width / 3));
  if (start > 0) {
    const sp = text.indexOf(' ', start);
    start = sp >= 0 && sp < firstHit ? sp + 1 : start;
  }
  let end = Math.min(text.length, start + width);
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    end = sp > start ? sp : end;
  }
  const window = `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  const segs: SnippetSegment[] = [];
  for (const part of window.split(/([\p{L}\p{N}]+)/u)) {
    if (!part) continue;
    const hit = /[\p{L}\p{N}]/u.test(part) && matchesTerm(part, terms);
    const last = segs[segs.length - 1];
    if (last && last.hit === hit) last.text += part;
    else segs.push({ text: part, hit });
  }
  return segs;
}

/** Tekst fragmentu do wycinków i cytatów: bez znaczników nagłówków Markdown, w jednej linii. */
export function plainText(content: string): string {
  return content
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Opis miejsca w dokumencie: „s. 3”, „Umowa › Kaucja, linie 5–7”. */
export function locatorLabel(l: {
  page: number | null;
  lineStart: number | null;
  lineEnd: number | null;
  heading: string | null;
}): string {
  if (l.page !== null) return `s. ${l.page}`;
  const lines =
    l.lineStart === null
      ? ''
      : l.lineEnd !== null && l.lineEnd !== l.lineStart
        ? `linie ${l.lineStart}–${l.lineEnd}`
        : `linia ${l.lineStart}`;
  return [l.heading, lines].filter(Boolean).join(', ') || 'fragment';
}
