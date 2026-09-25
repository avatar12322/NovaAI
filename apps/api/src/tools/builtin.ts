import { LIMITS } from '@nova/contracts';
import { decideCreate, decideHouseholdNotify } from '@nova/permissions';
import { z } from 'zod';
import { withUserTx } from '../db/pool';
import { emitEvent } from '../events';
import { createMemory } from '../modules/memories';
import { ToolDenied, type ToolDef } from './types';

const actorOf = (ctx: Parameters<ToolDef['authorize']>[0]) => ({
  userId: ctx.principal.userId,
  activeHouseholdIds: ctx.principal.activeHouseholdIds,
  context: ctx.context,
});

/**
 * memory.create — zapis faktu w pamięci. Agent prywatny zapisuje prywatnie; NovaAI zapisuje
 * wyłącznie do przestrzeni wspólnej (rozmowa wspólna jest już widoczna dla obojga).
 */
export const memoryCreateTool: ToolDef<{
  content: string;
  kind: 'profile' | 'episodic' | 'knowledge';
}> = {
  name: 'memory.create',
  capability: 'memory.create',
  title: 'Zapisz w pamięci',
  contexts: ['private_agent', 'household_agent'],
  params: z.object({
    content: z.string().trim().min(1).max(LIMITS.memoryChars),
    kind: z.enum(['profile', 'episodic', 'knowledge']).default('profile'),
  }),
  requiresApproval: () => false,
  async preview(ctx, p) {
    return {
      summary: `Zapis w pamięci: „${p.content.slice(0, 120)}”`,
      target: ctx.context === 'household_agent' ? 'pamięć wspólna' : 'pamięć prywatna',
      scope: p.kind,
    };
  },
  async authorize(ctx) {
    return decideCreate(actorOf(ctx), 'memory.create', {
      householdId: ctx.householdId,
      visibility: ctx.context === 'household_agent' ? 'shared' : 'private',
    });
  },
  async execute(ctx, p, idempotencyKey) {
    const shared = ctx.context === 'household_agent';
    // Idempotencja: to samo źródło (klucz) nie tworzy drugiego wpisu.
    const source = `agent:${idempotencyKey}`;
    const memory = await withUserTx(
      ctx.deps.db,
      { userId: ctx.principal.userId, scope: 'user' },
      async (c) => {
        const existing = await c.query<{ id: string }>(
          'SELECT id FROM memories WHERE source = $1',
          [source],
        );
        if (existing.rows[0]) return { id: existing.rows[0].id };
        const m = await createMemory(c, {
          householdId: ctx.householdId,
          userId: ctx.principal.userId,
          kind: p.kind,
          content: p.content,
          shared,
          source,
          sourceConversationId: ctx.conversationId,
        });
        await emitEvent(c, {
          householdId: ctx.householdId,
          ownerUserId: ctx.principal.userId,
          visibility: shared ? 'shared' : 'private',
          taskId: ctx.taskId,
          type: 'memory.changed',
          payload: { memoryId: m.id, change: 'created' },
        });
        return m;
      },
    );
    return {
      summary: shared ? 'Zapisano w pamięci wspólnej' : 'Zapisano w pamięci prywatnej',
      output: { memoryId: memory.id },
    };
  },
};

/**
 * household.notify — wiadomość do drugiego członka domu. ZAWSZE wymaga zgody nadawcy
 * na dokładną treść i odbiorcę (podgląd w Approval Center).
 */
export const householdNotifyTool: ToolDef<{ message: string; toUserId?: string }> = {
  name: 'household.notify',
  capability: 'household.notify',
  title: 'Wyślij wiadomość do domownika',
  contexts: ['private_agent', 'user'],
  params: z.object({
    message: z.string().trim().min(1).max(1000),
    toUserId: z.uuid().optional(),
  }),
  requiresApproval: () => true,
  async prepare(ctx, p) {
    if (p.toUserId) return p;
    // Domyślny odbiorca: jedyny inny aktywny członek domu. Wieloznaczność => odmowa.
    const r = await ctx.deps.db.owner.query<{ user_id: string }>(
      `SELECT user_id FROM memberships WHERE household_id = $1 AND status = 'active' AND user_id <> $2`,
      [ctx.householdId, ctx.principal.userId],
    );
    if (r.rows.length !== 1) throw new ToolDenied('ambiguous_recipient');
    return { ...p, toUserId: r.rows[0]!.user_id };
  },
  async preview(ctx, p) {
    const name = await recipientName(ctx, p.toUserId);
    return {
      summary: `Wiadomość do: ${name}`,
      target: name,
      scope: 'powiadomienie w NovaAI (jednorazowe)',
      diff: p.message,
    };
  },
  async authorize(ctx, p) {
    if (!p.toUserId) return { allow: false, reason: 'no_recipient' };
    const r = await ctx.deps.db.owner.query(
      `SELECT 1 FROM memberships WHERE household_id = $1 AND user_id = $2 AND status = 'active'`,
      [ctx.householdId, p.toUserId],
    );
    return decideHouseholdNotify(actorOf(ctx), {
      householdId: ctx.householdId,
      targetUserId: p.toUserId,
      targetActiveMember: r.rowCount === 1,
    });
  },
  async execute(ctx, p, idempotencyKey) {
    const c = await ctx.deps.db.owner.connect();
    try {
      await c.query('BEGIN');
      const ins = await c.query<{ id: string }>(
        `INSERT INTO notifications (household_id, user_id, kind, title, body, ref_type, ref_id, idempotency_key)
         VALUES ($1, $2, 'household.message', $3, $4, 'user', $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [
          ctx.householdId,
          p.toUserId,
          `Wiadomość od: ${ctx.principal.displayName}`,
          p.message,
          ctx.principal.userId,
          idempotencyKey,
        ],
      );
      if (ins.rows[0]) {
        await emitEvent(c, {
          householdId: ctx.householdId,
          ownerUserId: p.toUserId!,
          visibility: 'private',
          type: 'notification.created',
          payload: { notificationId: ins.rows[0].id, kind: 'household.message' },
        });
      }
      await c.query('COMMIT');
      return {
        summary: ins.rows[0] ? 'Wiadomość wysłana' : 'Wiadomość już wysłana (powtórzenie)',
        output: { notificationId: ins.rows[0]?.id ?? null },
      };
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  },
};

async function recipientName(
  ctx: Parameters<ToolDef['preview']>[0],
  userId: string | undefined,
): Promise<string> {
  if (!userId) return 'nieznany odbiorca';
  const r = await ctx.deps.db.owner.query<{ display_name: string }>(
    'SELECT display_name FROM users WHERE id = $1',
    [userId],
  );
  return r.rows[0]?.display_name ?? 'nieznany odbiorca';
}
