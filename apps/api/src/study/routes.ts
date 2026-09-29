import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUuid, requireAuth } from '../access';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { warsawClock } from '../digest/service';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import {
  addCards,
  addDeadline,
  DEADLINE_KINDS,
  deleteDeadline,
  deleteDeck,
  dueCards,
  listDeadlines,
  listDecks,
  parseLocalDue,
  reviewCard,
  setDeadlineDone,
} from './service';

/** Terminy i fiszki — prywatne każdej osoby. */
const NewDeadline = z.object({
  title: z.string().trim().min(1).max(200),
  subject: z.string().trim().max(200).default(''),
  kind: z.enum(DEADLINE_KINDS).default('inne'),
  /** „RRRR-MM-DD” (cały dzień) albo „RRRR-MM-DDTGG:MM” — czas polski. */
  due: z
    .string()
    .refine((s) => parseLocalDue(s) !== null, 'Termin: RRRR-MM-DD albo RRRR-MM-DDTGG:MM'),
});
const Card = z.object({
  front: z.string().trim().min(1).max(1000),
  back: z.string().trim().min(1).max(2000),
});
const NewDeck = z.object({
  title: z.string().trim().min(1).max(200),
  subject: z.string().trim().max(200).default(''),
  cards: z.array(Card).max(200).default([]),
});

export const studyRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const member = (req: FastifyRequest) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      return { userId: auth.userId, householdId: auth.householdId };
    };
    const asUser = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
      withUserTx(deps.db, { userId, scope: 'user' }, fn);
    const today = () => warsawClock(new Date()).date;

    app.get('/deadlines', async (req) => {
      const m = member(req);
      return { items: await asUser(m.userId, (c) => listDeadlines(c)) };
    });

    app.post('/deadlines', async (req, reply) => {
      const m = member(req);
      const b = parse(NewDeadline, req.body);
      if (parseLocalDue(b.due)!.at.getTime() < Date.now() - 86_400_000)
        throw badRequest('Termin nie może być w przeszłości');
      const d = await asUser(m.userId, (c) => addDeadline(c, { householdId: m.householdId, ...b }));
      return reply.status(201).send({ deadline: d });
    });

    app.patch<{ Params: { id: string } }>('/deadlines/:id', async (req) => {
      const m = member(req);
      if (!isUuid(req.params.id)) throw notFound('Termin');
      const { done } = parse(z.object({ done: z.boolean() }), req.body);
      if (!(await asUser(m.userId, (c) => setDeadlineDone(c, req.params.id, done))))
        throw notFound('Termin');
      return { ok: true };
    });

    app.delete<{ Params: { id: string } }>('/deadlines/:id', async (req, reply) => {
      const m = member(req);
      if (!isUuid(req.params.id)) throw notFound('Termin');
      if (!(await asUser(m.userId, (c) => deleteDeadline(c, req.params.id))))
        throw notFound('Termin');
      return reply.status(204).send();
    });

    app.get('/flashcards/decks', async (req) => {
      const m = member(req);
      return { items: await asUser(m.userId, (c) => listDecks(c, today())) };
    });

    app.post('/flashcards/decks', async (req, reply) => {
      const m = member(req);
      const b = parse(NewDeck, req.body);
      const r = await asUser(m.userId, (c) =>
        addCards(c, m.householdId, { title: b.title, subject: b.subject }, b.cards),
      );
      return reply.status(201).send(r);
    });

    app.get<{ Params: { id: string } }>('/flashcards/decks/:id/due', async (req) => {
      const m = member(req);
      if (!isUuid(req.params.id)) throw notFound('Talia');
      return { items: await asUser(m.userId, (c) => dueCards(c, req.params.id, today())) };
    });

    app.post<{ Params: { id: string } }>('/flashcards/:id/review', async (req) => {
      const m = member(req);
      if (!isUuid(req.params.id)) throw notFound('Fiszka');
      const { known } = parse(z.object({ known: z.boolean() }), req.body);
      const r = await asUser(m.userId, (c) => reviewCard(c, req.params.id, known, today()));
      if (!r) throw notFound('Fiszka');
      return r;
    });

    app.delete<{ Params: { id: string } }>('/flashcards/decks/:id', async (req, reply) => {
      const m = member(req);
      if (!isUuid(req.params.id)) throw notFound('Talia');
      if (!(await asUser(m.userId, (c) => deleteDeck(c, req.params.id)))) throw notFound('Talia');
      return reply.status(204).send();
    });
  };
