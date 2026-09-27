import { Fragment, type ReactNode } from 'react';

/**
 * Prosty Markdown w odpowiedziach asystenta: **pogrubienie**, *kursywa*, `kod`, nagłówki (jako pogrubiona
 * linia), listy (• / 1.) i linki http(s). Tylko elementy Reacta — żadnego HTML z treści odpowiedzi.
 * Niedomknięte ** na końcu (tekst odsłaniany albo pisany na żywo) formatuje resztę, bez migających gwiazdek.
 * Układ linii zostaje (kontener ma white-space: pre-wrap).
 */
const INLINE =
  /(`[^`\n]+`)|(\*\*|__)(?=\S)([\s\S]*?\S)\2|\*\*(?=\S)([^\n]*)$|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}-${i++}`;
    const [, code, , bold, openBold, italic, underline, label, href] = m;
    if (code) out.push(<code key={k}>{code.slice(1, -1)}</code>);
    else if (bold !== undefined) out.push(<strong key={k}>{inline(bold, k)}</strong>);
    else if (openBold !== undefined) out.push(<strong key={k}>{inline(openBold, k)}</strong>);
    else if (italic !== undefined || underline !== undefined)
      out.push(<em key={k}>{inline((italic ?? underline)!, k)}</em>);
    else if (label !== undefined)
      out.push(
        /^https?:\/\//i.test(href!) ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        ) : (
          label
        ),
      );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function line(raw: string, key: string): ReactNode {
  const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(raw);
  if (heading)
    return <strong key={key}>{inline(heading[1]!.replace(/\s+#+\s*$/, ''), key)}</strong>;
  const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(raw);
  if (bullet)
    return <Fragment key={key}>{[`${bullet[1]}• `, ...inline(bullet[2]!, key)]}</Fragment>;
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) return <Fragment key={key} />; // linia pozioma
  const quote = /^\s*>\s?(.*)$/.exec(raw);
  if (quote) return <em key={key}>{inline(quote[1]!, key)}</em>;
  return <Fragment key={key}>{inline(raw, key)}</Fragment>;
}

export function renderMarkdown(text: string): ReactNode {
  const lines = text.split('\n');
  return lines.map((l, i) => (
    <Fragment key={i}>
      {line(l, `l${i}`)}
      {i < lines.length - 1 ? '\n' : null}
    </Fragment>
  ));
}

/** Tekst bez znaczników (np. dla czytnika ekranu). */
export function plainText(text: string): string {
  return text
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^(\s*)[-*•]\s+/, '$1• ')
        .replace(/\*\*|__|`/g, '')
        .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1'),
    )
    .join('\n');
}
