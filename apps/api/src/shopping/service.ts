import type pg from 'pg';
import { emitEvent } from '../events';

/**
 * Wspólna lista zakupów domu. Wszystkie operacje w transakcji użytkownika (RLS: tylko członkowie domu).
 * Pozycje odhaczone są widoczne jeszcze przez dobę (do „Usuń kupione”), potem znikają z listy.
 */
export const MAX_OPEN_ITEMS = 200;
const MAX_TEXT = 200;

export interface ShoppingItem {
  id: string;
  text: string;
  addedBy: string;
  checked: boolean;
  createdAt: string;
  checkedAt: string | null;
}

/** „  mleko   2l ” → „mleko 2l”; puste pomijane. */
export function normalizeItem(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

const key = (text: string) => normalizeItem(text).toLocaleLowerCase('pl-PL');

async function changed(c: pg.PoolClient, householdId: string, userId: string): Promise<void> {
  await emitEvent(c, {
    householdId,
    ownerUserId: userId,
    visibility: 'shared',
    type: 'shopping.changed',
    payload: {},
  });
}

export async function listItems(c: pg.PoolClient, householdId: string): Promise<ShoppingItem[]> {
  const r = await c.query<{
    id: string;
    text: string;
    added_by: string;
    checked_at: string | null;
    created_at: string;
  }>(
    `SELECT id, text, added_by, checked_at, created_at FROM shopping_items
      WHERE household_id = $1 AND (checked_at IS NULL OR checked_at > now() - interval '1 day')
      ORDER BY checked_at IS NOT NULL, CASE WHEN checked_at IS NULL THEN created_at END,
               checked_at DESC`,
    [householdId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    text: x.text,
    addedBy: x.added_by,
    checked: x.checked_at !== null,
    createdAt: x.created_at,
    checkedAt: x.checked_at,
  }));
}

/** Dodanie pozycji: bez powtórzeń wśród niekupionych (wielkość liter bez znaczenia). */
export async function addItems(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  texts: readonly string[],
): Promise<{ added: string[]; skipped: string[] }> {
  const open = await c.query<{ text: string }>(
    `SELECT text FROM shopping_items WHERE household_id = $1 AND checked_at IS NULL`,
    [householdId],
  );
  const seen = new Set(open.rows.map((x) => key(x.text)));
  const added: string[] = [];
  const skipped: string[] = [];
  for (const raw of texts) {
    const text = normalizeItem(raw);
    if (!text) continue;
    if (seen.has(key(text))) {
      skipped.push(text);
      continue;
    }
    if (seen.size >= MAX_OPEN_ITEMS) {
      skipped.push(text);
      continue;
    }
    seen.add(key(text));
    added.push(text);
  }
  if (added.length) {
    await c.query(
      `INSERT INTO shopping_items (household_id, added_by, text)
       SELECT $1, nova_uid(), t FROM unnest($2::text[]) WITH ORDINALITY AS x(t, n) ORDER BY n`,
      [householdId, added],
    );
    await changed(c, householdId, userId);
  }
  return { added, skipped };
}

/**
 * Odhaczenie po nazwach (asystent: „kupiłem mleko”): najpierw dokładna nazwa, potem jedyna pozycja,
 * która zawiera podany tekst. Niejednoznaczne i nieznalezione — zwracane bez zmian.
 */
export async function checkByName(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  names: readonly string[],
): Promise<{ checked: string[]; notFound: string[] }> {
  const open = await c.query<{ id: string; text: string }>(
    `SELECT id, text FROM shopping_items WHERE household_id = $1 AND checked_at IS NULL
      ORDER BY created_at`,
    [householdId],
  );
  const remaining = [...open.rows];
  const checked: string[] = [];
  const notFound: string[] = [];
  const ids: string[] = [];
  for (const raw of names) {
    const k = key(raw);
    if (!k) continue;
    let i = remaining.findIndex((x) => key(x.text) === k);
    if (i < 0) {
      const partial = remaining
        .map((x, idx) => ({ idx, hit: key(x.text).includes(k) }))
        .filter((x) => x.hit);
      i = partial.length === 1 ? partial[0]!.idx : -1;
    }
    if (i < 0) {
      notFound.push(normalizeItem(raw));
      continue;
    }
    const [item] = remaining.splice(i, 1);
    ids.push(item!.id);
    checked.push(item!.text);
  }
  if (ids.length) {
    await c.query(
      `UPDATE shopping_items SET checked_at = now(), checked_by = nova_uid()
        WHERE id = ANY($1::uuid[]) AND household_id = $2`,
      [ids, householdId],
    );
    await changed(c, householdId, userId);
  }
  return { checked, notFound };
}

export async function updateItem(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  id: string,
  patch: { checked?: boolean; text?: string },
): Promise<boolean> {
  const sets: string[] = [];
  const args: unknown[] = [id, householdId];
  if (patch.checked !== undefined)
    sets.push(
      patch.checked
        ? 'checked_at = coalesce(checked_at, now()), checked_by = coalesce(checked_by, nova_uid())'
        : 'checked_at = NULL, checked_by = NULL',
    );
  if (patch.text !== undefined) {
    args.push(normalizeItem(patch.text));
    sets.push(`text = $${args.length}`);
  }
  if (!sets.length) return true;
  const r = await c.query(
    `UPDATE shopping_items SET ${sets.join(', ')} WHERE id = $1 AND household_id = $2`,
    args,
  );
  if (r.rowCount) await changed(c, householdId, userId);
  return (r.rowCount ?? 0) > 0;
}

export async function removeItem(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  id: string,
): Promise<boolean> {
  const r = await c.query('DELETE FROM shopping_items WHERE id = $1 AND household_id = $2', [
    id,
    householdId,
  ]);
  if (r.rowCount) await changed(c, householdId, userId);
  return (r.rowCount ?? 0) > 0;
}

export async function clearChecked(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
): Promise<number> {
  const r = await c.query(
    'DELETE FROM shopping_items WHERE household_id = $1 AND checked_at IS NOT NULL',
    [householdId],
  );
  if (r.rowCount) await changed(c, householdId, userId);
  return r.rowCount ?? 0;
}

/** Krótka forma do przeglądu dnia: „mleko, jajka, chleb (+3)”. */
export function shortList(texts: readonly string[], max = 5): string {
  const shown = texts.slice(0, max).join(', ');
  return texts.length > max ? `${shown} (+${texts.length - max})` : shown;
}
