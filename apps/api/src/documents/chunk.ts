/**
 * Podział dokumentu na fragmenty do wyszukiwania i cytowania. Fragment nigdy nie przekracza granicy
 * strony (PDF), więc cytat wskazuje dokładną stronę; w TXT/Markdown fragment zna zakres linii,
 * a w Markdown także ścieżkę nagłówków („Umowa › Kaucja”).
 */
export interface ChunkDraft {
  page: number | null;
  lineStart: number | null;
  lineEnd: number | null;
  heading: string | null;
  content: string;
}

export const CHUNK_TARGET = 900;
export const CHUNK_MAX = 1400;

interface Block {
  text: string;
  lineStart: number;
  lineEnd: number;
  heading: string | null;
  /** Nagłówek Markdown — zaczyna nowy fragment. */
  isHeading?: boolean;
}

/** Dzieli zbyt długi blok na części ≤ CHUNK_MAX (po liniach, a gdy linia jest za długa — po zdaniach/słowach). */
function splitLong(b: Block): Block[] {
  if (b.text.length <= CHUNK_MAX) return [b];
  const out: Block[] = [];
  const lines = b.text.split('\n');
  let cur: string[] = [];
  let curStart = b.lineStart;
  let lineNo = b.lineStart;
  const flush = (endLine: number) => {
    if (cur.length) out.push({ ...b, text: cur.join('\n'), lineStart: curStart, lineEnd: endLine });
    cur = [];
  };
  for (const line of lines) {
    if (line.length > CHUNK_MAX) {
      flush(lineNo - 1);
      // Jedna bardzo długa linia: tniemy po granicach zdań/słów, numer linii zostaje ten sam.
      let rest = line;
      while (rest.length > CHUNK_MAX) {
        let cut = rest.lastIndexOf('. ', CHUNK_TARGET);
        if (cut < CHUNK_TARGET / 2) cut = rest.lastIndexOf(' ', CHUNK_TARGET);
        if (cut < CHUNK_TARGET / 2) cut = CHUNK_TARGET;
        out.push({ ...b, text: rest.slice(0, cut + 1).trim(), lineStart: lineNo, lineEnd: lineNo });
        rest = rest.slice(cut + 1);
      }
      cur = rest.trim() ? [rest.trim()] : [];
      curStart = lineNo;
    } else {
      if (cur.join('\n').length + line.length + 1 > CHUNK_TARGET && cur.length) {
        flush(lineNo - 1);
        curStart = lineNo;
      }
      if (!cur.length) curStart = lineNo;
      cur.push(line);
    }
    lineNo++;
  }
  flush(b.lineEnd);
  return out;
}

/** Łączy bloki w fragmenty ~CHUNK_TARGET znaków; nagłówek zawsze zaczyna nowy fragment. */
function pack(blocks: Block[], page: number | null): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];
  let cur: Block[] = [];
  const flush = () => {
    const text = cur
      .map((b) => b.text)
      .join('\n\n')
      .trim();
    if (text) {
      chunks.push({
        page,
        lineStart: page === null ? cur[0]!.lineStart : null,
        lineEnd: page === null ? cur[cur.length - 1]!.lineEnd : null,
        heading: cur[cur.length - 1]!.heading ?? cur[0]!.heading,
        content: text,
      });
    }
    cur = [];
  };
  for (const block of blocks.flatMap(splitLong)) {
    const size = cur.reduce((n, b) => n + b.text.length + 2, 0);
    if (cur.length && (block.isHeading || size + block.text.length > CHUNK_TARGET)) flush();
    cur.push(block);
  }
  flush();
  return chunks;
}

/** Bloki = akapity oddzielone pustą linią; w Markdown nagłówki są osobnymi blokami (poza blokami kodu). */
function toBlocks(text: string, markdown: boolean): Block[] {
  const blocks: Block[] = [];
  const headingPath: string[] = [];
  let buf: string[] = [];
  let bufStart = 1;
  let inFence = false;
  const lines = text.split('\n');
  const current = () => (headingPath.length ? headingPath.filter(Boolean).join(' › ') : null);
  const flush = (endLine: number) => {
    const t = buf.join('\n').trim();
    if (t) blocks.push({ text: t, lineStart: bufStart, lineEnd: endLine, heading: current() });
    buf = [];
  };
  lines.forEach((line, i) => {
    const no = i + 1;
    if (markdown && /^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = markdown && !inFence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) {
      flush(no - 1);
      const level = h[1]!.length;
      headingPath.length = level - 1;
      headingPath[level - 1] = h[2]!.slice(0, 120);
      blocks.push({
        text: line.trim(),
        lineStart: no,
        lineEnd: no,
        heading: current(),
        isHeading: true,
      });
      bufStart = no + 1;
      return;
    }
    if (!line.trim() && !inFence) {
      flush(no - 1);
      bufStart = no + 1;
      return;
    }
    if (!buf.length) bufStart = no;
    buf.push(line);
  });
  flush(lines.length);
  return blocks;
}

export function chunkText(text: string, format: 'txt' | 'md'): ChunkDraft[] {
  return pack(toBlocks(text, format === 'md'), null);
}

/** PDF: fragmenty w obrębie strony (numer strony od 1). */
export function chunkPages(pages: Array<{ page: number; text: string }>): ChunkDraft[] {
  return pages.flatMap((p) => pack(toBlocks(p.text, false), p.page));
}
