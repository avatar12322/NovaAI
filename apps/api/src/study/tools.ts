import { z } from 'zod';
import { plural } from '../briefing/routes';
import { withUserTx } from '../db/pool';
import { ToolDenied, type ToolContext, type ToolDef } from '../tools/types';
import {
  addCards,
  addDeadline,
  DEADLINE_KINDS,
  KIND_PL,
  listDeadlines,
  parseLocalDue,
  setDeadlineDone,
} from './service';

/**
 * Terminy i fiszki przez asystenta prywatnego: „kolokwium z analizy 15.10 o 10”, „co mam do oddania?”,
 * „zrób fiszki z notatek z narrative design” (model czyta dokument narzędziem dokumentów i tworzy karty).
 */
const asUser = <T>(ctx: ToolContext, fn: Parameters<typeof withUserTx<T>>[2]) =>
  withUserTx(ctx.deps.db, { userId: ctx.principal.userId, scope: 'user' }, fn);
const onlyPrivate = async (ctx: ToolContext) =>
  ctx.context === 'private_agent'
    ? { allow: true, reason: 'owner' }
    : { allow: false, reason: 'private_only' };
const when = (iso: string, allDay: boolean) =>
  new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw',
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    ...(allDay ? {} : { hour: '2-digit', minute: '2-digit' }),
  }).format(new Date(iso));

type DeadlineParams = {
  title: string;
  subject: string;
  kind: (typeof DEADLINE_KINDS)[number];
  due: string;
};

export const deadlineAddTool: ToolDef<DeadlineParams> = {
  name: 'deadline.add',
  capability: 'deadline.add',
  title:
    'Zapisz termin (kind: egzamin — egzamin/kolokwium, oddanie — projekt/zlecenie, inne). due: RRRR-MM-DD albo RRRR-MM-DDTGG:MM czasu polskiego. Przypomnienie w przeglądach dnia (3 dni wcześniej, dzień wcześniej, w dniu).',
  contexts: ['private_agent'],
  params: z.object({
    title: z.string().trim().min(1).max(200),
    subject: z.string().trim().max(200).default(''),
    kind: z.enum(DEADLINE_KINDS).default('inne'),
    due: z.string().refine((s) => parseLocalDue(s) !== null, 'RRRR-MM-DD[TGG:MM]'),
  }) as unknown as z.ZodType<DeadlineParams>,
  requiresApproval: () => false,
  async preview(_ctx, p) {
    return { summary: `Termin: ${p.title}`, target: 'Twoje terminy', scope: p.due };
  },
  authorize: onlyPrivate,
  async execute(ctx, p) {
    const due = parseLocalDue(p.due)!;
    if (due.at.getTime() < Date.now() - 86_400_000) throw new ToolDenied('due_in_past');
    const d = await asUser(ctx, (c) => addDeadline(c, { householdId: ctx.householdId, ...p }));
    return {
      summary: `Zapisano termin: ${KIND_PL[d.kind]} — ${d.title}${d.subject ? ` (${d.subject})` : ''}, ${when(d.dueAt, d.allDay)}`,
      output: { deadlineId: d.id },
    };
  },
};

export const deadlineListTool: ToolDef<Record<string, never>> = {
  name: 'deadline.list',
  capability: 'deadline.read',
  title: 'Pokaż nadchodzące terminy (egzaminy, kolokwia, oddania) z identyfikatorami',
  contexts: ['private_agent'],
  readOnly: true,
  params: z.object({}) as unknown as z.ZodType<Record<string, never>>,
  requiresApproval: () => false,
  async preview() {
    return { summary: 'Terminy', target: 'Twoje terminy', scope: 'odczyt' };
  },
  authorize: onlyPrivate,
  async execute(ctx) {
    const items = (await asUser(ctx, (c) => listDeadlines(c))).filter((d) => !d.done);
    return {
      summary: items.length
        ? `Nadchodzące terminy (${items.length})`
        : 'Brak nadchodzących terminów',
      output: {
        lines: items.map(
          (d) =>
            `[${d.id}] ${when(d.dueAt, d.allDay)}: ${KIND_PL[d.kind]} — ${d.title}${d.subject ? ` (${d.subject})` : ''}`,
        ),
      },
    };
  },
};

export const deadlineDoneTool: ToolDef<{ deadlineId: string }> = {
  name: 'deadline.done',
  capability: 'deadline.add',
  title: 'Oznacz termin jako zrobiony/zaliczony (identyfikator z deadline.list)',
  contexts: ['private_agent'],
  params: z.object({ deadlineId: z.uuid() }),
  requiresApproval: () => false,
  async preview(_ctx, p) {
    return { summary: 'Termin zrobiony', target: 'Twoje terminy', scope: p.deadlineId };
  },
  authorize: onlyPrivate,
  async execute(ctx, p) {
    if (!(await asUser(ctx, (c) => setDeadlineDone(c, p.deadlineId, true))))
      throw new ToolDenied('deadline_not_found');
    return { summary: 'Oznaczono termin jako zrobiony', output: { done: true } };
  },
};

type CardsParams = {
  deck: string;
  subject: string;
  cards: Array<{ front: string; back: string }>;
};

export const flashcardsCreateTool: ToolDef<CardsParams> = {
  name: 'flashcards.create',
  capability: 'flashcards.create',
  title:
    'Utwórz fiszki do nauki (talia = temat; ta sama nazwa dopisuje karty). Karty krótkie: pytanie na przodzie, zwięzła odpowiedź z tyłu. Treść z notatek/dokumentów użytkownika — najpierw je przeczytaj.',
  contexts: ['private_agent'],
  params: z.object({
    deck: z.string().trim().min(1).max(200),
    subject: z.string().trim().max(200).default(''),
    cards: z
      .array(
        z.object({
          front: z.string().trim().min(1).max(1000),
          back: z.string().trim().min(1).max(2000),
        }),
      )
      .min(1)
      .max(50),
  }) as unknown as z.ZodType<CardsParams>,
  requiresApproval: () => false,
  async preview(_ctx, p) {
    return {
      summary: `Fiszki „${p.deck}”: ${p.cards.length}`,
      target: 'Twoje fiszki',
      scope: 'nowe karty',
    };
  },
  authorize: onlyPrivate,
  async execute(ctx, p) {
    const r = await asUser(ctx, (c) =>
      addCards(c, ctx.householdId, { title: p.deck, subject: p.subject }, p.cards),
    );
    return {
      summary: `Dodano ${plural(r.added, 'fiszkę', 'fiszki', 'fiszek')} do talii „${p.deck}” — nauka: Dokumenty → Fiszki`,
      output: { deckId: r.deckId },
    };
  },
};

export const STUDY_TOOLS = [
  deadlineAddTool,
  deadlineListTool,
  deadlineDoneTool,
  flashcardsCreateTool,
];
