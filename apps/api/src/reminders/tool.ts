import { decideCreate } from '@nova/permissions';
import { z } from 'zod';
import { withUserTx } from '../db/pool';
import { ToolDenied, type ToolDef } from '../tools/types';
import { createReminder, ReminderError } from './service';

/**
 * reminder.create — agent prywatny tworzy przypomnienie prywatne; NovaAI — wspólne (dla domowników).
 * Bez zgody (dotyczy wyłącznie autora lub przestrzeni wspólnej, w której padła prośba).
 */
export const reminderCreateTool: ToolDef<{ text: string; dueAt: string }> = {
  name: 'reminder.create',
  capability: 'reminder.create',
  title: 'Utwórz przypomnienie',
  contexts: ['private_agent', 'household_agent'],
  params: z.object({
    text: z.string().trim().min(1).max(500),
    dueAt: z.iso.datetime({ offset: true }),
  }),
  requiresApproval: () => false,
  async preview(ctx, p) {
    return {
      summary: `Przypomnienie: ${p.text.slice(0, 80)}`,
      target: ctx.context === 'household_agent' ? 'domownicy' : 'Ty',
      scope: p.dueAt,
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
            dueAt: new Date(p.dueAt),
            source: `agent:${key}`,
            requestId: ctx.correlationId,
          });
        },
      );
      ctx.deps.kickQueue();
      return { summary: `Ustawiono przypomnienie na ${p.dueAt}`, output: { reminderId: r.id } };
    } catch (e) {
      if (e instanceof ReminderError) throw new ToolDenied(e.code);
      throw e;
    }
  },
};
