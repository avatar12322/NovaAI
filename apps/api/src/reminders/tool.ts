import { decideCreate } from '@nova/permissions';
import { z } from 'zod';
import { withSystemTx, withUserTx } from '../db/pool';
import { DEFAULT_ZONE, wallClockToUtc } from '../calendar/ics';
import { ToolDenied, type ToolDef } from '../tools/types';
import { cancelReminder, createReminder, ReminderError, reminderWhen } from './service';

/**
 * reminder.create — agent prywatny tworzy przypomnienie prywatne; NovaAI — wspólne (dla domowników).
 * Bez zgody (dotyczy wyłącznie autora lub przestrzeni wspólnej, w której padła prośba).
 */
/** Czas lokalny w Polsce bez strefy (RRRR-MM-DDTGG:MM[:SS]) — model nie musi znać przesunięcia (DST). */
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Termin z modelu: czas lokalny w Polsce albo ISO 8601 ze strefą. */
export function parseDue(s: string): Date {
  const m = LOCAL_TIME.exec(s);
  if (!m) return new Date(s);
  const [y, mo, d, h, mi, sec] = m.slice(1).map((x) => Number(x ?? 0));
  return wallClockToUtc(y!, mo!, d!, h!, mi!, sec!, DEFAULT_ZONE);
}

const DueAt = z
  .string()
  .refine((s) => LOCAL_TIME.test(s) || z.iso.datetime({ offset: true }).safeParse(s).success, {
    message: 'termin: czas lokalny RRRR-MM-DDTGG:MM albo ISO 8601 ze strefą',
  });

export const reminderCreateTool: ToolDef<{ text: string; dueAt: string }> = {
  name: 'reminder.create',
  capability: 'reminder.create',
  title: 'Utwórz przypomnienie',
  contexts: ['private_agent', 'household_agent'],
  params: z.object({
    text: z.string().trim().min(1).max(500),
    dueAt: DueAt,
  }),
  requiresApproval: () => false,
  async preview(ctx, p) {
    return {
      summary: `Przypomnienie: ${p.text.slice(0, 80)}`,
      target: ctx.context === 'household_agent' ? 'domownicy' : 'Ty',
      scope: reminderWhen(parseDue(p.dueAt)),
    };
  },
  async authorize(ctx) {
    return decideCreate(
      {
        userId: ctx.principal.userId,
        activeHouseholdIds: ctx.principal.activeHouseholdIds,
        context: ctx.context,
      },
      'task.create',
      {
        householdId: ctx.householdId,
        visibility: ctx.context === 'household_agent' ? 'shared' : 'private',
      },
    );
  },
  async execute(ctx, p, key) {
    const visibility = ctx.context === 'household_agent' ? 'shared' : 'private';
    try {
      const r = await withUserTx(
        ctx.deps.db,
        { userId: ctx.principal.userId, scope: 'user' },
        async (c) => {
          const existing = await c.query<{ id: string }>(
            `SELECT id FROM reminders WHERE source = $1`,
            [`agent:${key}`],
          );
          if (existing.rows[0]) return { id: existing.rows[0].id };
          return createReminder(c, {
            householdId: ctx.householdId,
            visibility,
            text: p.text,
            dueAt: parseDue(p.dueAt),
            source: `agent:${key}`,
            requestId: ctx.correlationId,
          });
        },
      );
      ctx.deps.kickQueue();
      return {
        summary: `Ustawiono przypomnienie${visibility === 'shared' ? ' wspólne' : ''}: ${reminderWhen(parseDue(p.dueAt))} — ${p.text.slice(0, 120)}`,
        output: { reminderId: r.id },
      };
    } catch (e) {
      if (e instanceof ReminderError) throw new ToolDenied(e.code);
      throw e;
    }
  },
};

/**
 * reminder.list — zaplanowane przypomnienia: agent prywatny widzi własne i wspólne, NovaAI (rozmowa wspólna)
 * — tylko wspólne. Tylko odczyt; identyfikatory służą do reminder.cancel.
 */
export const reminderListTool: ToolDef<{ max: number }> = {
  name: 'reminder.list',
  capability: 'reminder.list',
  title: 'Pokaż zaplanowane przypomnienia (najbliższe najpierw) — np. „jakie mam przypomnienia?”',
  contexts: ['private_agent', 'household_agent'],
  readOnly: true,
  params: z.object({ max: z.number().int().min(1).max(50).default(20) }),
  requiresApproval: () => false,
  async preview(ctx) {
    return {
      summary: 'Lista przypomnień',
      target: ctx.context === 'household_agent' ? 'wspólne przypomnienia' : 'Twoje przypomnienia',
      scope: 'odczyt',
    };
  },
  async authorize() {
    return { allow: true, reason: 'own_or_shared' };
  },
  async execute(ctx, p) {
    const sharedOnly = ctx.context === 'household_agent';
    const r = await withUserTx(ctx.deps.db, { userId: ctx.principal.userId, scope: 'user' }, (c) =>
      c.query<{ id: string; text: string; due_at: string; visibility: string; mine: boolean }>(
        `SELECT id, text, due_at, visibility, owner_user_id = nova_uid() AS mine FROM reminders
          WHERE household_id = $1 AND status = 'scheduled'
            AND (visibility = 'shared' OR (owner_user_id = nova_uid() AND NOT $2::boolean))
          ORDER BY due_at LIMIT $3`,
        [ctx.householdId, sharedOnly, p.max],
      ),
    );
    return {
      summary: r.rows.length
        ? `Zaplanowane przypomnienia: ${r.rows.length}`
        : 'Brak zaplanowanych przypomnień',
      output: {
        reminders: r.rows.map((x) => ({
          id: x.id,
          when: reminderWhen(x.due_at),
          text: x.text,
          shared: x.visibility === 'shared',
          // Anulować może tylko autor.
          canCancel: x.mine,
        })),
      },
    };
  },
};

/** reminder.cancel — anulowanie własnego zaplanowanego przypomnienia (identyfikator z reminder.list). */
export const reminderCancelTool: ToolDef<{ reminderId: string }> = {
  name: 'reminder.cancel',
  capability: 'reminder.cancel',
  title: 'Anuluj zaplanowane przypomnienie (identyfikator z listy przypomnień)',
  contexts: ['private_agent', 'household_agent'],
  params: z.object({ reminderId: z.uuid() }),
  requiresApproval: () => false,
  async preview(_ctx, p) {
    return { summary: 'Anulowanie przypomnienia', target: 'Ty', scope: p.reminderId };
  },
  async authorize() {
    return { allow: true, reason: 'owner_checked_on_execute' };
  },
  async execute(ctx, p) {
    const text = await withSystemTx(ctx.deps.db, async (c) => {
      const cur = await c.query<{ text: string }>(
        `SELECT text FROM reminders WHERE id = $1 AND owner_user_id = $2 AND status = 'scheduled'`,
        [p.reminderId, ctx.principal.userId],
      );
      if (!cur.rows[0] || !(await cancelReminder(c, p.reminderId, ctx.principal.userId)))
        return null;
      return cur.rows[0].text;
    });
    if (text === null) throw new ToolDenied('reminder_not_found');
    return {
      summary: `Anulowano przypomnienie: ${text.slice(0, 120)}`,
      output: { cancelled: true },
    };
  },
};
