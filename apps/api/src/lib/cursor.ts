import { badRequest } from './errors';

/** Kursor stronicowania (created_at|updated_at, id) — nieprzezroczysty dla klienta. */
export interface Cursor {
  ts: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.ts}|${c.id}`, 'utf8').toString('base64url');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const [ts, id] = decoded.split('|');
  if (!ts || !id || !UUID_RE.test(id) || Number.isNaN(Date.parse(ts))) {
    throw badRequest('Nieprawidłowy kursor');
  }
  return { ts, id };
}

export function pageResult<T extends { id: string }>(
  rows: T[],
  limit: number,
  tsOf: (row: T) => string,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ ts: tsOf(last), id: last.id }) : null,
  };
}
