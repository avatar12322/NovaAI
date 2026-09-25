/**
 * Leksykalna walidacja ścieżek po stronie brokera (warstwa 1). Worker wykonuje walidację kanoniczną
 * (realpath, symlinki/junctions) — warstwa 2. Obsługuje ścieżki Windows (C:\…) i POSIX (/…).
 */
export type PathStyle = 'windows' | 'posix';

export interface NormalizedPath {
  style: PathStyle;
  /** Segmenty bez pustych i `.`; dla windows pierwszy segment to litera dysku, np. `c:`. */
  segments: string[];
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export class PathRejected extends Error {}

export function normalizePath(input: string): NormalizedPath {
  if (!input || input.length > 1024) throw new PathRejected('pusta lub zbyt długa ścieżka');
  if (input.includes('\0')) throw new PathRejected('znak NUL w ścieżce');
  const isWin = /^[a-zA-Z]:[\\/]/.test(input);
  if (!isWin && !input.startsWith('/')) throw new PathRejected('wymagana ścieżka bezwzględna');
  if (/^[\\/]{2}/.test(input)) throw new PathRejected('ścieżki UNC/urządzeń są niedozwolone');
  const raw = input.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.');
  const segments: string[] = [];
  for (const [i, seg] of raw.entries()) {
    if (seg === '..') throw new PathRejected('segment „..” jest niedozwolony');
    if (isWin) {
      if (i === 0) {
        segments.push(seg.toLowerCase());
        continue;
      }
      if (seg.includes(':'))
        throw new PathRejected('alternatywne strumienie danych (:) są niedozwolone');
      if (WIN_RESERVED.test(seg)) throw new PathRejected('zarezerwowana nazwa urządzenia Windows');
      if (/[ .]$/.test(seg)) throw new PathRejected('segment kończący się spacją lub kropką');
      segments.push(seg.toLowerCase());
    } else {
      segments.push(seg);
    }
  }
  return { style: isWin ? 'windows' : 'posix', segments };
}

/** Czy `path` leży w `root` (lub jest nim). Porównanie po segmentach — `C:\a` nie obejmuje `C:\ab`. */
export function isWithinRoot(path: string, root: string): boolean {
  let p: NormalizedPath;
  let r: NormalizedPath;
  try {
    p = normalizePath(path);
    r = normalizePath(root);
  } catch {
    return false;
  }
  if (p.style !== r.style || r.segments.length > p.segments.length) return false;
  return r.segments.every((s, i) => s === p.segments[i]);
}
