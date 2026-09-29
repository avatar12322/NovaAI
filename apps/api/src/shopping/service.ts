import type pg from 'pg';
import { emitEvent } from '../events';
import { productName, stock, unstockSince } from '../pantry/service';

/**
 * Wspólna lista zakupów domu. Wszystkie operacje w transakcji użytkownika (RLS: tylko członkowie domu).
 * Pozycje odhaczone są widoczne jeszcze przez dobę (do „Usuń kupione”), potem znikają z listy.
 * Kupione trafiają do spiżarni. `maybe` — „pewnie masz, sprawdź” (asystent nie jest pewien, czy jest w domu).
 */
export const MAX_OPEN_ITEMS = 200;
const MAX_TEXT = 200;

export interface ShoppingItem {
  id: string;
  text: string;
  addedBy: string;
  checked: boolean;
  /** „Pewnie masz — sprawdź”: do kupienia tylko, jeśli w domu tego nie ma. */
  maybe: boolean;
  createdAt: string;
  checkedAt: string | null;
}

/** „  mleko   2l ” → „mleko 2l”; puste pomijane. */
export function normalizeItem(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

const key = (text: string) => normalizeItem(text).toLocaleLowerCase('pl-PL');

async function notifyChanged(c: pg.PoolClient, householdId: string, userId: string): Promise<void> {
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
    maybe: boolean;
    created_at: string;
  }>(
    `SELECT id, text, added_by, checked_at, maybe, created_at FROM shopping_items
      WHERE household_id = $1 AND (checked_at IS NULL OR checked_at > now() - interval '1 day')
      ORDER BY checked_at IS NOT NULL, maybe, CASE WHEN checked_at IS NULL THEN created_at END,
               checked_at DESC`,
    [householdId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    text: x.text,
    addedBy: x.added_by,
    checked: x.checked_at !== null,
    maybe: x.maybe,
    createdAt: x.created_at,
    checkedAt: x.checked_at,
  }));
}

/**
 * Dodanie pozycji: bez powtórzeń wśród niekupionych (wielkość liter bez znaczenia). Pozycja „pewnie masz”
 * dodana jako pewna (inny przepis jej potrzebuje) przechodzi do „do kupienia”.
 */
export async function addItems(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  texts: readonly string[],
  maybe = false,
): Promise<{ added: string[]; skipped: string[] }> {
  const open = await c.query<{ id: string; text: string; maybe: boolean }>(
    `SELECT id, text, maybe FROM shopping_items WHERE household_id = $1 AND checked_at IS NULL`,
    [householdId],
  );
  const seen = new Set(open.rows.map((x) => key(x.text)));
  const unsure = new Map(open.rows.filter((x) => x.maybe).map((x) => [key(x.text), x.id]));
  const added: string[] = [];
  const inserted: string[] = [];
  const skipped: string[] = [];
  for (const raw of texts) {
    const text = normalizeItem(raw);
    if (!text) continue;
    if (!maybe && unsure.has(key(text))) {
      await c.query('UPDATE shopping_items SET maybe = false WHERE id = $1', [
        unsure.get(key(text)),
      ]);
      unsure.delete(key(text));
      added.push(text);
      continue;
    }
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
    inserted.push(text);
  }
  if (inserted.length) {
    await c.query(
      `INSERT INTO shopping_items (household_id, added_by, text, maybe)
       SELECT $1, nova_uid(), t, $3 FROM unnest($2::text[]) WITH ORDINALITY AS x(t, n) ORDER BY n`,
      [householdId, inserted, maybe],
    );
  }
  if (added.length) await notifyChanged(c, householdId, userId);
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
    await notifyChanged(c, householdId, userId);
    await stock(c, householdId, userId, checked.map(productName), { learn: true });
  }
  return { checked, notFound };
}

/**
 * Zmiana treści pozycji do kupienia po nazwie (np. suma ilości z kilku przepisów: „jajka 3 szt.” →
 * „jajka 5 szt.”): dokładna nazwa albo jedyna pasująca. Nieznalezione zwracane — dodaje je wywołujący.
 */
export async function renameByName(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  changes: ReadonlyArray<{ from: string; to: string }>,
): Promise<{ changed: string[]; notFound: Array<{ from: string; to: string }> }> {
  const open = await c.query<{ id: string; text: string }>(
    `SELECT id, text FROM shopping_items WHERE household_id = $1 AND checked_at IS NULL
      ORDER BY created_at`,
    [householdId],
  );
  const remaining = [...open.rows];
  const changed: string[] = [];
  const notFound: Array<{ from: string; to: string }> = [];
  for (const ch of changes) {
    const k = key(ch.from);
    const to = normalizeItem(ch.to);
    if (!k || !to) continue;
    let i = remaining.findIndex((x) => key(x.text) === k);
    if (i < 0) {
      const partial = remaining.flatMap((x, idx) => (key(x.text).includes(k) ? [idx] : []));
      i = partial.length === 1 ? partial[0]! : -1;
    }
    if (i < 0) {
      notFound.push({ from: normalizeItem(ch.from), to });
      continue;
    }
    const [item] = remaining.splice(i, 1);
    await c.query('UPDATE shopping_items SET text = $3 WHERE id = $1 AND household_id = $2', [
      item!.id,
      householdId,
      to,
    ]);
    changed.push(`${item!.text} → ${to}`);
  }
  if (changed.length) await notifyChanged(c, householdId, userId);
  return { changed, notFound };
}

/** Zmiana pozycji z ekranu: odhaczenie (kupione → spiżarnia; cofnięcie — z powrotem), treść, „pewnie masz”. */
export async function updateItem(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  id: string,
  patch: { checked?: boolean; text?: string; maybe?: boolean },
): Promise<boolean> {
  const before = await c.query<{ text: string; checked_at: string | null }>(
    'SELECT text, checked_at FROM shopping_items WHERE id = $1 AND household_id = $2',
    [id, householdId],
  );
  const item = before.rows[0];
  if (!item) return false;
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
  if (patch.maybe !== undefined) {
    args.push(patch.maybe);
    sets.push(`maybe = $${args.length}`);
  }
  if (!sets.length) return true;
  const r = await c.query(
    `UPDATE shopping_items SET ${sets.join(', ')} WHERE id = $1 AND household_id = $2`,
    args,
  );
  if (!r.rowCount) return false;
  await notifyChanged(c, householdId, userId);
  const name = productName(patch.text ?? item.text);
  if (patch.checked === true && !item.checked_at)
    await stock(c, householdId, userId, [name], { learn: true });
  if (patch.checked === false && item.checked_at)
    await unstockSince(c, householdId, userId, name, item.checked_at);
  return true;
}

/** „Mam” przy pozycji „pewnie masz”: znika z listy, a spiżarnia wie, że jest w domu. */
export async function haveItem(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  id: string,
): Promise<boolean> {
  const r = await c.query<{ text: string }>(
    'DELETE FROM shopping_items WHERE id = $1 AND household_id = $2 AND checked_at IS NULL RETURNING text',
    [id, householdId],
  );
  if (!r.rows[0]) return false;
  await notifyChanged(c, householdId, userId);
  await stock(c, householdId, userId, [productName(r.rows[0].text)], { learn: false });
  return true;
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
  if (r.rowCount) await notifyChanged(c, householdId, userId);
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
  if (r.rowCount) await notifyChanged(c, householdId, userId);
  return r.rowCount ?? 0;
}

/** Krótka forma do przeglądu dnia: „mleko, jajka, chleb (+3)”. */
export function shortList(texts: readonly string[], max = 5): string {
  const shown = texts.slice(0, max).join(', ');
  return texts.length > max ? `${shown} (+${texts.length - max})` : shown;
}
