import type pg from 'pg';
import { emitEvent } from '../events';

/**
 * Spiżarnia domu: co jest w lodówce, zamrażarce i szafce — bez liczenia ilości, tylko szacunek
 * „masz / kończy się / raczej nie masz” z daty zakupu i przewidywanej trwałości. Trwałość startuje z typowej
 * dla produktu i uczy się z tego, jak szybko rzecz naprawdę schodzi (także gdy zjadają ją domownicy).
 * Wszystko w transakcji użytkownika (RLS: członkowie domu).
 */
export type Place = 'lodowka' | 'zamrazarka' | 'szafka';
export type PantryStatus = 'masz' | 'konczy_sie' | 'raczej_nie';

export const PLACE_PL: Record<Place, string> = {
  lodowka: 'lodówka',
  zamrazarka: 'zamrażarka',
  szafka: 'szafka',
};
export const STATUS_PL: Record<PantryStatus, string> = {
  masz: 'masz',
  konczy_sie: 'pewnie się kończy',
  raczej_nie: 'raczej nie masz',
};
/** Danie z przepisu uznane za ugotowane po tylu dniach (chyba że użytkownik powie inaczej). */
export const MEAL_COOKED_AFTER_DAYS = 3;
const MAX_ITEMS = 300;
const DAY_MS = 86_400_000;

export interface PantryItem {
  id: string;
  name: string;
  place: Place;
  status: PantryStatus;
  /** Dni od zakupu (albo potwierdzenia, że jest). */
  ageDays: number;
  shelfDays: number;
  stockedAt: string;
}

const UNITS = new Set(
  (
    'g kg dag dkg ml l szt sztuka sztuki sztuk op opak opakowanie opakowania łyżka łyżki łyżek łyżeczka ' +
    'łyżeczki łyżeczek szklanka szklanki szklanek szczypta garść pęczek pęczki puszka puszki słoik słoiki ' +
    'butelka butelki kostka kostki plaster plastry ząbek ząbki ząbków pół ok około x litr litry litrów'
  ).split(' '),
);
const SIZES = new Set(
  (
    'średni średnia średnie średnich średniej duży duża duże dużych dużej mały mała małe małych małej ' +
    'płaska płaskie płaskiej płaskich świeży świeża świeże świeżego świeżej świeżych pełna pełnej'
  ).split(' '),
);

/**
 * Nazwa produktu z pozycji listy zakupów albo składnika: „jajka 5 szt.” → „jajka”,
 * „3 średnie cebule - 350 g” → „cebule”, „papryki: 2 żółte” → „papryki”.
 */
export function productName(text: string): string {
  const head = text
    .toLocaleLowerCase('pl-PL')
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s[-–=]\s|:/)[0]!;
  const words = head
    .split(/\s+/)
    .map((w) => w.replace(/[.,;]+$/, ''))
    .filter((w) => w && !/^[\d/,.½¼¾]+/.test(w) && !UNITS.has(w) && !SIZES.has(w));
  const name = words.join(' ').trim();
  return (name || text.trim().toLocaleLowerCase('pl-PL')).slice(0, 120);
}

// ponytail: odmiana przez obcięcie końcowych samogłosek („cebula”/„cebule”, „jajka”/„jajko” — ten sam klucz);
// pomyłki („ogórek”/„ogórki”) poprawia model, który widzi spiżarnię i podaje istniejące nazwy.
export function nameKey(name: string): string {
  return productName(name)
    .split(/\s+/)
    .map((w) => w.replace(/[aeiouyąęó]+$/u, '') || w)
    .join(' ');
}

const RULES: Array<[RegExp, Place, number]> = [
  [/mrożon/, 'zamrazarka', 90],
  [/papryk\w* (słodk|ostr|wędzon|mielon)/, 'szafka', 180],
  [/(chleb|bułk|bagietk|rogal|pieczyw|chałk|tortill)/, 'szafka', 3],
  [
    /(mąk|cukier|cukru|ryż|makaron|kasz|olej|oliw|ocet|octu|przypraw|konserw|puszk|kawa|kawy|herbat|płatk|miód|miodu|dżem|kakao|drożdż|proszek|soda|tarta|fasol|soczewic|ciecierzyc|orzech|rodzynk|koncentrat|ketchup|musztard|majonez|sos )/,
    'szafka',
    180,
  ],
  [
    /(mięs|kurczak|pierś|piersi|filet|mielon|schab|karków|wołow|wieprz|indyk|ryb|łosoś|dorsz|krewet|udk|skrzyd)/,
    'lodowka',
    3,
  ],
  [/(kiełbas|parówk|szynk|boczek|wędlin|salami|kabanos|pasztet)/, 'lodowka', 7],
  [
    /(mlek|mleczk|śmietan|kefir|jogurt|maślank|twaróg|twarog|serek|mascarpone|mozzarell|feta|ricott)/,
    'lodowka',
    6,
  ],
  [/(^|\s)(ser|sera|serem)(\s|$)/, 'lodowka', 14],
  [/(jajk|jaja|jajek)/, 'lodowka', 21],
  [/(masło|masła|margaryn)/, 'lodowka', 21],
  [/(ziemniak|cebul|czosn|marchew|marchw|burak|jabłk|dyni)/, 'szafka', 21],
  [/cytryn|limonk|pomarańcz|mandaryn|kapust|seler/, 'lodowka', 14],
];

/** Typowe miejsce i trwałość produktu (start; potem uczona z zakupów). */
export function defaultsFor(name: string): { place: Place; days: number } {
  const n = productName(name);
  for (const [re, place, days] of RULES) if (re.test(n)) return { place, days };
  return { place: 'lodowka', days: 7 };
}

export function statusOf(ageDays: number, shelfDays: number): PantryStatus {
  const r = ageDays / shelfDays;
  return r >= 1 ? 'raczej_nie' : r >= 0.7 ? 'konczy_sie' : 'masz';
}

async function changed(c: pg.PoolClient, householdId: string, userId: string): Promise<void> {
  await emitEvent(c, {
    householdId,
    ownerUserId: userId,
    visibility: 'shared',
    type: 'pantry.changed',
    payload: {},
  });
}

interface Row {
  id: string;
  name: string;
  name_key: string;
  place: Place;
  shelf_days: number;
  stocked_at: string;
  used_up_at: string | null;
}

async function byKey(c: pg.PoolClient, householdId: string): Promise<Map<string, Row>> {
  const r = await c.query<Row>(
    `SELECT id, name, name_key, place, shelf_days, stocked_at, used_up_at FROM pantry_items
      WHERE household_id = $1`,
    [householdId],
  );
  return new Map(r.rows.map((x) => [x.name_key, x]));
}

/**
 * Jest w domu (zakupy, „mam jeszcze …”, zdjęcie lodówki): nowa pozycja albo odświeżenie istniejącej.
 * `learn` — zakup: trwałość zbliża się do tego, ile rzecz faktycznie wytrzymała (średnia z poprzednią).
 */
export async function stock(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  names: readonly string[],
  opts: { learn: boolean; now?: Date },
): Promise<string[]> {
  const now = opts.now ?? new Date();
  const rows = await byKey(c, householdId);
  const done: string[] = [];
  for (const raw of names) {
    const name = productName(raw);
    const key = nameKey(name);
    if (!key) continue;
    const row = rows.get(key);
    if (row) {
      let shelf = row.shelf_days;
      // ponytail: tempo zużycia z jednego przedziału (średnia z dotychczasową); zakup „na zapas” skraca szacunek.
      const end = row.used_up_at ? Date.parse(row.used_up_at) : now.getTime();
      const lasted = (end - Date.parse(row.stocked_at)) / DAY_MS;
      if (opts.learn && lasted >= 1)
        shelf = Math.min(3650, Math.max(1, Math.round((shelf + lasted) / 2)));
      await c.query(
        `UPDATE pantry_items SET stocked_at = $2, used_up_at = NULL, shelf_days = $3 WHERE id = $1`,
        [row.id, now, shelf],
      );
    } else {
      if (rows.size >= MAX_ITEMS) continue;
      const d = defaultsFor(name);
      const ins = await c.query<Row>(
        `INSERT INTO pantry_items (household_id, name, name_key, place, shelf_days, stocked_at, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, nova_uid())
         RETURNING id, name, name_key, place, shelf_days, stocked_at, used_up_at`,
        [householdId, name, key, d.place, d.days, now],
      );
      rows.set(key, ins.rows[0]!);
    }
    done.push(name);
  }
  if (done.length) await changed(c, householdId, userId);
  return done;
}

/** Skończyło się (albo zużyte w daniu): znika ze spiżarni, zostaje w historii do uczenia trwałości. */
export async function useUp(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  names: readonly string[],
  now = new Date(),
): Promise<{ gone: string[]; notFound: string[] }> {
  const rows = await byKey(c, householdId);
  const gone: string[] = [];
  const notFound: string[] = [];
  for (const raw of names) {
    const row = rows.get(nameKey(raw));
    if (!row || row.used_up_at) {
      notFound.push(productName(raw));
      continue;
    }
    await c.query('UPDATE pantry_items SET used_up_at = $2 WHERE id = $1', [row.id, now]);
    row.used_up_at = now.toISOString();
    gone.push(row.name);
  }
  if (gone.length) await changed(c, householdId, userId);
  return { gone, notFound };
}

/** Cofnięcie odhaczenia na liście zakupów: pozycja spiżarni dodana tym odhaczeniem znika. */
export async function unstockSince(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  name: string,
  since: string,
): Promise<void> {
  const r = await c.query(
    `DELETE FROM pantry_items WHERE household_id = $1 AND name_key = $2
        AND created_at >= $3::timestamptz - interval '2 seconds'`,
    [householdId, nameKey(name), since],
  );
  if (r.rowCount) await changed(c, householdId, userId);
}

/** Danie z przepisu: składniki (`uses`) uznane za zużyte po MEAL_COOKED_AFTER_DAYS albo gdy ugotowane. */
export async function planMeal(
  c: pg.PoolClient,
  householdId: string,
  title: string,
  uses: readonly string[],
): Promise<void> {
  await c.query(
    `INSERT INTO meals (household_id, title, uses, added_by) VALUES ($1, $2, $3, nova_uid())`,
    [householdId, title.slice(0, 200), uses.map(productName).slice(0, 60)],
  );
}

/**
 * „Zrobiłem leczo” → składniki zużyte teraz; „jeszcze nie gotowałem” → kolejne dni na ugotowanie.
 * Zwraca tytuł dopasowanego dania (ostatnie nieugotowane o pasującej nazwie) albo null.
 */
export async function mealCooked(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  title: string,
  cooked: boolean,
  now = new Date(),
): Promise<string | null> {
  const r = await c.query<{ id: string; title: string; uses: string[] }>(
    `SELECT id, title, uses FROM meals
      WHERE household_id = $1 AND cooked_at IS NULL AND lower(title) LIKE '%' || lower($2) || '%'
      ORDER BY planned_at DESC LIMIT 1`,
    [householdId, title.trim().replace(/[%_\\]/g, '')],
  );
  const meal = r.rows[0];
  if (!meal) return null;
  if (cooked) {
    await c.query('UPDATE meals SET cooked_at = $2 WHERE id = $1', [meal.id, now]);
    await useUp(c, householdId, userId, meal.uses, now);
  } else {
    await c.query('UPDATE meals SET planned_at = $2 WHERE id = $1', [meal.id, now]);
  }
  return meal.title;
}

/** Dania nieoznaczone przez użytkownika: po MEAL_COOKED_AFTER_DAYS uznane za ugotowane. */
export async function settleMeals(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  now = new Date(),
): Promise<void> {
  const due = await c.query<{ uses: string[]; cooked_at: string }>(
    `UPDATE meals SET cooked_at = planned_at + make_interval(days => ${MEAL_COOKED_AFTER_DAYS})
      WHERE household_id = $1 AND cooked_at IS NULL
        AND planned_at < $2::timestamptz - make_interval(days => ${MEAL_COOKED_AFTER_DAYS})
      RETURNING uses, cooked_at`,
    [householdId, now],
  );
  for (const m of due.rows) await useUp(c, householdId, userId, m.uses, new Date(m.cooked_at));
}

/** Stan spiżarni (bez zużytych) — najpierw rozliczenie dań, które pewnie zostały ugotowane. */
export async function listPantry(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  now = new Date(),
): Promise<PantryItem[]> {
  await settleMeals(c, householdId, userId, now);
  const r = await c.query<Row>(
    `SELECT id, name, name_key, place, shelf_days, stocked_at, used_up_at FROM pantry_items
      WHERE household_id = $1 AND used_up_at IS NULL ORDER BY place, name`,
    [householdId],
  );
  return r.rows.map((x) => {
    const ageDays = Math.max(0, (now.getTime() - Date.parse(x.stocked_at)) / DAY_MS);
    return {
      id: x.id,
      name: x.name,
      place: x.place,
      status: statusOf(ageDays, x.shelf_days),
      ageDays: Math.floor(ageDays),
      shelfDays: x.shelf_days,
      stockedAt: x.stocked_at,
    };
  });
}

/** Pojedyncza pozycja z ekranu spiżarni: „jest” (odświeżenie) albo „skończyło się”. */
export async function setById(
  c: pg.PoolClient,
  householdId: string,
  userId: string,
  id: string,
  action: 'have' | 'gone' | 'remove',
): Promise<boolean> {
  const r =
    action === 'remove'
      ? await c.query('DELETE FROM pantry_items WHERE id = $1 AND household_id = $2', [
          id,
          householdId,
        ])
      : await c.query(
          action === 'have'
            ? 'UPDATE pantry_items SET stocked_at = now(), used_up_at = NULL WHERE id = $1 AND household_id = $2'
            : 'UPDATE pantry_items SET used_up_at = now() WHERE id = $1 AND household_id = $2 AND used_up_at IS NULL',
          [id, householdId],
        );
  if (r.rowCount) await changed(c, householdId, userId);
  return (r.rowCount ?? 0) > 0;
}

/** Spiżarnia dla modelu: po stanie, z wiekiem („cebula, 9 dni”). */
export function pantryLines(items: readonly PantryItem[]): string[] {
  const by = (s: PantryStatus) =>
    items
      .filter((i) => i.status === s)
      .map((i) => `${i.name} (${PLACE_PL[i.place]}, ${i.ageDays} dni)`)
      .join(', ');
  return (['masz', 'konczy_sie', 'raczej_nie'] as const)
    .map((s) => [s, by(s)] as const)
    .filter(([, v]) => v)
    .map(([s, v]) => `- ${STATUS_PL[s]}: ${v}`);
}
