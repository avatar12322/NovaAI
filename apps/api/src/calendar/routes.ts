import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUuid, requireAuth } from '../access';
import { writeAudit } from '../audit';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { IcsError, parseIcs, type IcsResult } from './ics';

/**
 * Kalendarz z pliku .ics (np. plan zajęć z dziekanatu): wgranie, podmiana nowym plikiem, usunięcie. Wydarzenia
 * trafiają do kalendarza lokalnego właściciela — tylko on je widzi (RLS). Plik nie jest przechowywany.
 */
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 3000;
/** Okno dat importu: od miesiąca wstecz do ponad roku naprzód (plan semestru i roku akademickiego). */
const PAST_MS = 31 * 86_400_000;
const FUTURE_MS = 400 * 86_400_000;

interface ImportRow {
  id: string;
  name: string;
  event_count: number;
  visible_count: number;
  updated_at: string;
  first_at: string | null;
  last_at: string | null;
  next_at: string | null;
}

function readFile(req: FastifyRequest): IcsResult {
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0)
    throw badRequest('Wybierz plik kalendarza (.ics)');
  const now = Date.now();
  try {
    return parseIcs(body.toString('utf8'), {
      from: new Date(now - PAST_MS),
      to: new Date(now + FUTURE_MS),
      maxEvents: MAX_EVENTS,
    });
  } catch (e) {
    if (e instanceof IcsError) throw badRequest(e.message);
    throw e;
  }
}

function importName(req: FastifyRequest): string {
  const raw = (req.query as { name?: unknown }).name;
  const name = typeof raw === 'string' ? raw.trim().slice(0, 120) : '';
  return name || 'Plan zajęć';
}

async function insertEvents(
  c: pg.PoolClient,
  householdId: string,
  importId: string,
  r: IcsResult,
  excluded: readonly string[] = [],
): Promise<void> {
  if (!r.events.length) return;
  await c.query(
    `INSERT INTO local_calendar_events
       (household_id, owner_user_id, import_id, title, starts_at, ends_at, location, notes, hidden)
     SELECT $1, nova_uid(), $2, x.t, x.s, x.e, x.l, x.n, x.t = ANY($8::text[])
       FROM unnest($3::text[], $4::timestamptz[], $5::timestamptz[], $6::text[], $7::text[])
         AS x(t, s, e, l, n)`,
    [
      householdId,
      importId,
      r.events.map((e) => e.title),
      r.events.map((e) => e.startsAt.toISOString()),
      r.events.map((e) => e.endsAt.toISOString()),
      r.events.map((e) => e.location),
      r.events.map((e) => e.notes),
      excluded,
    ],
  );
}

// Zakres i najbliższe zajęcia — tylko z przedmiotów pokazywanych (nieodznaczonych).
const SELECT_IMPORTS = `
  SELECT i.id, i.name, i.event_count, i.updated_at,
         (count(e.id) FILTER (WHERE NOT e.hidden))::int AS visible_count,
         min(e.starts_at) FILTER (WHERE NOT e.hidden) AS first_at,
         max(e.ends_at) FILTER (WHERE NOT e.hidden) AS last_at,
         min(e.starts_at) FILTER (WHERE NOT e.hidden AND e.starts_at > now()) AS next_at
    FROM calendar_imports i
    LEFT JOIN local_calendar_events e ON e.import_id = i.id
   WHERE i.owner_user_id = nova_uid()`;

interface Subject {
  title: string;
  count: number;
  hidden: boolean;
}

/** Przedmioty (tytuły) każdego planu z liczbą zajęć — do wyboru, które pokazywać. */
async function subjectsOf(c: pg.PoolClient, ids: string[]): Promise<Map<string, Subject[]>> {
  const out = new Map<string, Subject[]>();
  if (!ids.length) return out;
  const r = await c.query<{ import_id: string; title: string; n: number; hidden: boolean }>(
    `SELECT import_id, title, count(*)::int AS n, bool_or(hidden) AS hidden
       FROM local_calendar_events WHERE import_id = ANY($1::uuid[])
      GROUP BY import_id, title ORDER BY title`,
    [ids],
  );
  for (const x of r.rows)
    out.set(x.import_id, [
      ...(out.get(x.import_id) ?? []),
      { title: x.title, count: x.n, hidden: x.hidden },
    ]);
  return out;
}

const toJson = (r: ImportRow, subjects: Map<string, Subject[]>) => ({
  id: r.id,
  name: r.name,
  eventCount: r.event_count,
  visibleCount: r.visible_count,
  updatedAt: r.updated_at,
  firstAt: r.first_at,
  lastAt: r.last_at,
  nextAt: r.next_at,
  subjects: subjects.get(r.id) ?? [],
});

const Subjects = z.object({
  excluded: z.array(z.string().min(1).max(200)).max(500),
});

export const calendarImportRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    // Plik jako surowe bajty (bez multipart), jak przy dokumentach.
    for (const type of ['text/calendar', 'application/octet-stream'])
      app.addContentTypeParser(
        type,
        { parseAs: 'buffer', bodyLimit: MAX_BYTES },
        (_r, body, done) => done(null, body),
      );

    const user = (req: FastifyRequest) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      return { auth, householdId: auth.householdId };
    };
    const audit = (
      req: FastifyRequest,
      userId: string,
      householdId: string,
      action: string,
      importId: string,
      details: Record<string, unknown>,
    ) =>
      writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: userId,
        ownerUserId: userId,
        householdId,
        source: 'api',
        action,
        resourceType: 'calendar_import',
        resourceId: importId,
        outcome: 'ok',
        correlationId: req.id,
        details,
      });
    /** Plan w odpowiedzi API (z listą przedmiotów). */
    const one = async (c: pg.PoolClient, id: string) => {
      const row = (await c.query<ImportRow>(`${SELECT_IMPORTS} AND i.id = $1 GROUP BY i.id`, [id]))
        .rows[0];
      if (!row) throw notFound('Kalendarz');
      return toJson(row, await subjectsOf(c, [id]));
    };

    app.get('/calendar/imports', async (req) => {
      const { auth } = user(req);
      const items = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const r = await c.query<ImportRow>(`${SELECT_IMPORTS} GROUP BY i.id ORDER BY i.created_at`);
        const subjects = await subjectsOf(
          c,
          r.rows.map((x) => x.id),
        );
        return r.rows.map((x) => toJson(x, subjects));
      });
      return { items };
    });

    app.post('/calendar/imports', { bodyLimit: MAX_BYTES }, async (req, reply) => {
      const { auth, householdId } = user(req);
      const parsed = readFile(req);
      if (!parsed.events.length)
        throw badRequest(
          'W pliku nie ma zajęć w najbliższym roku. Na stronie planu wybierz zakres dat (np. cały semestr), kliknij „Szukaj”, a potem „Zapisz jako ical”.',
        );
      const row = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO calendar_imports (household_id, owner_user_id, name, event_count)
           VALUES ($1, nova_uid(), $2, $3) RETURNING id`,
          [householdId, importName(req), parsed.events.length],
        );
        await insertEvents(c, householdId, ins.rows[0]!.id, parsed);
        return one(c, ins.rows[0]!.id);
      });
      await audit(req, auth.userId, householdId, 'calendar.import', row.id, {
        events: parsed.events.length,
        skipped: parsed.skipped,
      });
      return reply.status(201).send({ import: row, skipped: parsed.skipped });
    });

    // Nowa wersja planu: wydarzenia z tego importu zastąpione w całości (jedna transakcja).
    app.put<{ Params: { id: string } }>(
      '/calendar/imports/:id',
      { bodyLimit: MAX_BYTES },
      async (req) => {
        const { auth, householdId } = user(req);
        if (!isUuid(req.params.id)) throw notFound('Kalendarz');
        const parsed = readFile(req);
        const row = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
          const upd = await c.query<{ excluded_titles: string[] }>(
            `UPDATE calendar_imports SET event_count = $2, updated_at = now() WHERE id = $1
             RETURNING excluded_titles`,
            [req.params.id, parsed.events.length],
          );
          if (upd.rowCount !== 1) throw notFound('Kalendarz');
          await c.query(`DELETE FROM local_calendar_events WHERE import_id = $1`, [req.params.id]);
          // Wybór przedmiotów zostaje: odznaczone w poprzedniej wersji są ukryte także w nowej.
          await insertEvents(c, householdId, req.params.id, parsed, upd.rows[0]!.excluded_titles);
          return one(c, req.params.id);
        });
        await audit(req, auth.userId, householdId, 'calendar.import_replace', req.params.id, {
          events: parsed.events.length,
          skipped: parsed.skipped,
        });
        return { import: row, skipped: parsed.skipped };
      },
    );

    // Wybór przedmiotów: odznaczone (np. zajęcia innych grup z planu toku) są ukryte wszędzie.
    app.patch<{ Params: { id: string } }>('/calendar/imports/:id', async (req) => {
      const { auth, householdId } = user(req);
      if (!isUuid(req.params.id)) throw notFound('Kalendarz');
      const { excluded } = parse(Subjects, req.body);
      const row = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const upd = await c.query(
          `UPDATE calendar_imports SET excluded_titles = $2, updated_at = now() WHERE id = $1`,
          [req.params.id, [...new Set(excluded)]],
        );
        if (upd.rowCount !== 1) throw notFound('Kalendarz');
        await c.query(
          `UPDATE local_calendar_events SET hidden = (title = ANY($2::text[])) WHERE import_id = $1`,
          [req.params.id, excluded],
        );
        return one(c, req.params.id);
      });
      await audit(req, auth.userId, householdId, 'calendar.import_subjects', req.params.id, {
        excluded: excluded.length,
      });
      return { import: row };
    });

    app.delete<{ Params: { id: string } }>('/calendar/imports/:id', async (req, reply) => {
      const { auth, householdId } = user(req);
      if (!isUuid(req.params.id)) throw notFound('Kalendarz');
      await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        await c.query(`DELETE FROM local_calendar_events WHERE import_id = $1`, [req.params.id]);
        const del = await c.query(`DELETE FROM calendar_imports WHERE id = $1`, [req.params.id]);
        if (del.rowCount !== 1) throw notFound('Kalendarz');
      });
      await audit(req, auth.userId, householdId, 'calendar.import_delete', req.params.id, {});
      return reply.status(204).send();
    });
  };
