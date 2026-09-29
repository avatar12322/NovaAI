import type pg from 'pg';
import { DEFAULT_ZONE, wallClockToUtc } from '../calendar/ics';

/**
 * Terminy (egzamin/kolokwium, oddanie projektu lub zlecenia) i fiszki (metoda Leitnera). Wszystko prywatne
 * właściciela (RLS). Czas lokalny w Polsce; termin bez godziny = cały dzień.
 */
export const DEADLINE_KINDS = ['egzamin', 'oddanie', 'inne'] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];
export const KIND_PL: Record<DeadlineKind, string> = {
  egzamin: 'Egzamin / kolokwium',
  oddanie: 'Oddanie (projekt, zlecenie)',
  inne: 'Termin',
};

/** Przerwy między powtórkami w pudełkach 1–5 (dni). */
export const LEITNER_DAYS = [1, 2, 4, 8, 16] as const;

export interface Deadline {
  id: string;
  title: string;
  subject: string;
  kind: DeadlineKind;
  dueAt: string;
  allDay: boolean;
  done: boolean;
}

/** „RRRR-MM-DD” albo „RRRR-MM-DDTGG:MM” (czas polski) → chwila + cały dzień. */
export function parseLocalDue(s: string): { at: Date; allDay: boolean } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map((x) => (x === undefined ? undefined : Number(x)));
  const allDay = h === undefined;
  const at = wallClockToUtc(y!, mo!, d!, h ?? 0, mi ?? 0, 0, DEFAULT_ZONE);
  return Number.isNaN(at.getTime()) ? null : { at, allDay };
}

interface DeadlineRow {
  id: string;
  title: string;
  subject: string;
  kind: DeadlineKind;
  due_at: string;
  all_day: boolean;
  done_at: string | null;
}
const toDeadline = (r: DeadlineRow): Deadline => ({
  id: r.id,
  title: r.title,
  subject: r.subject,
  kind: r.kind,
  dueAt: r.due_at,
  allDay: r.all_day,
  done: r.done_at !== null,
});

/** Nadchodzące (i zaległe niezrobione z ostatnich 7 dni) terminy właściciela. */
export async function listDeadlines(c: pg.PoolClient): Promise<Deadline[]> {
  const r = await c.query<DeadlineRow>(
    `SELECT id, title, subject, kind, due_at, all_day, done_at FROM deadlines
      WHERE owner_user_id = nova_uid()
        AND (due_at > now() - interval '1 day' OR (done_at IS NULL AND due_at > now() - interval '7 days'))
      ORDER BY done_at IS NOT NULL, due_at LIMIT 100`,
  );
  return r.rows.map(toDeadline);
}

export async function addDeadline(
  c: pg.PoolClient,
  d: { householdId: string; title: string; subject: string; kind: DeadlineKind; due: string },
): Promise<Deadline> {
  const due = parseLocalDue(d.due);
  if (!due) throw new Error('bad_due');
  const r = await c.query<DeadlineRow>(
    `INSERT INTO deadlines (household_id, owner_user_id, title, subject, kind, due_at, all_day)
     VALUES ($1, nova_uid(), $2, $3, $4, $5, $6)
     RETURNING id, title, subject, kind, due_at, all_day, done_at`,
    [d.householdId, d.title, d.subject, d.kind, due.at, due.allDay],
  );
  return toDeadline(r.rows[0]!);
}

export async function setDeadlineDone(c: pg.PoolClient, id: string, done: boolean) {
  const r = await c.query(
    `UPDATE deadlines SET done_at = CASE WHEN $2 THEN coalesce(done_at, now()) ELSE NULL END
      WHERE id = $1 AND owner_user_id = nova_uid()`,
    [id, done],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function deleteDeadline(c: pg.PoolClient, id: string) {
  const r = await c.query('DELETE FROM deadlines WHERE id = $1 AND owner_user_id = nova_uid()', [
    id,
  ]);
  return (r.rowCount ?? 0) > 0;
}

/** Niezrobione terminy w danym dniu (czas polski) — do przeglądu dnia. */
export async function deadlinesOn(c: pg.PoolClient, date: string): Promise<Deadline[]> {
  const r = await c.query<DeadlineRow>(
    `SELECT id, title, subject, kind, due_at, all_day, done_at FROM deadlines
      WHERE owner_user_id = nova_uid() AND done_at IS NULL
        AND (due_at AT TIME ZONE '${DEFAULT_ZONE}')::date = $1::date
      ORDER BY due_at`,
    [date],
  );
  return r.rows.map(toDeadline);
}

export interface Deck {
  id: string;
  title: string;
  subject: string;
  cards: number;
  due: number;
  learned: number;
}

export async function listDecks(c: pg.PoolClient, today: string): Promise<Deck[]> {
  const r = await c.query<{
    id: string;
    title: string;
    subject: string;
    cards: number;
    due: number;
    learned: number;
  }>(
    `SELECT d.id, d.title, d.subject,
            count(f.id)::int AS cards,
            (count(f.id) FILTER (WHERE f.due_on <= $1::date))::int AS due,
            (count(f.id) FILTER (WHERE f.box >= 4))::int AS learned
       FROM flashcard_decks d LEFT JOIN flashcards f ON f.deck_id = d.id
      WHERE d.owner_user_id = nova_uid()
      GROUP BY d.id ORDER BY d.created_at DESC`,
    [today],
  );
  return r.rows;
}

/** Nowa talia z kartami (albo dopisanie do istniejącej o tym samym tytule). */
export async function addCards(
  c: pg.PoolClient,
  householdId: string,
  deck: { title: string; subject: string },
  cards: ReadonlyArray<{ front: string; back: string }>,
): Promise<{ deckId: string; added: number }> {
  const existing = await c.query<{ id: string }>(
    `SELECT id FROM flashcard_decks WHERE owner_user_id = nova_uid() AND lower(title) = lower($1)`,
    [deck.title],
  );
  const deckId =
    existing.rows[0]?.id ??
    (
      await c.query<{ id: string }>(
        `INSERT INTO flashcard_decks (household_id, owner_user_id, title, subject)
         VALUES ($1, nova_uid(), $2, $3) RETURNING id`,
        [householdId, deck.title, deck.subject],
      )
    ).rows[0]!.id;
  if (cards.length)
    await c.query(
      `INSERT INTO flashcards (deck_id, owner_user_id, front, back)
       SELECT $1, nova_uid(), f, b FROM unnest($2::text[], $3::text[]) AS x(f, b)`,
      [deckId, cards.map((x) => x.front), cards.map((x) => x.back)],
    );
  return { deckId, added: cards.length };
}

export interface Card {
  id: string;
  front: string;
  back: string;
  box: number;
}

/** Karty do powtórki dziś (najpierw z niższych pudełek). */
export async function dueCards(
  c: pg.PoolClient,
  deckId: string,
  today: string,
  limit = 30,
): Promise<Card[]> {
  const r = await c.query<Card>(
    `SELECT id, front, back, box FROM flashcards
      WHERE deck_id = $1 AND owner_user_id = nova_uid() AND due_on <= $2::date
      ORDER BY box, due_on, created_at LIMIT $3`,
    [deckId, today, limit],
  );
  return r.rows;
}

/** Ocena karty: „umiem” → wyższe pudełko i dłuższa przerwa; „jeszcze nie” → pudełko 1, jutro. */
export async function reviewCard(
  c: pg.PoolClient,
  id: string,
  known: boolean,
  today: string,
): Promise<{ box: number; dueOn: string } | null> {
  const cur = await c.query<{ box: number }>(
    'SELECT box FROM flashcards WHERE id = $1 AND owner_user_id = nova_uid()',
    [id],
  );
  const card = cur.rows[0];
  if (!card) return null;
  const box = known ? Math.min(5, card.box + 1) : 1;
  const days = LEITNER_DAYS[box - 1]!;
  const r = await c.query<{ due_on: string }>(
    `UPDATE flashcards SET box = $2, due_on = $3::date + $4::int WHERE id = $1
     RETURNING to_char(due_on, 'YYYY-MM-DD') AS due_on`,
    [id, box, today, days],
  );
  return { box, dueOn: r.rows[0]!.due_on };
}

export async function deleteDeck(c: pg.PoolClient, id: string) {
  const r = await c.query(
    'DELETE FROM flashcard_decks WHERE id = $1 AND owner_user_id = nova_uid()',
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Liczba kart do powtórki dziś (przegląd dnia). */
export async function dueCount(c: pg.PoolClient, today: string): Promise<number> {
  const r = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM flashcards WHERE owner_user_id = nova_uid() AND due_on <= $1::date`,
    [today],
  );
  return r.rows[0]?.n ?? 0;
}
