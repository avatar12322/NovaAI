import { z } from 'zod';
import { withUserTx } from '../db/pool';
import type { ToolDef } from '../tools/types';
import { mealCooked, stock, useUp } from './service';

type UpdateParams = { have: string[]; gone: string[]; cooked?: string; notCooked?: string };
const Names = z.array(z.string().trim().min(1).max(120)).max(60).default([]);

/**
 * Spiżarnia przez asystenta: „w lodówce mam …” (także zdjęcie lodówki — wtedy ze zgodą), „skończyło się
 * mleko”, „zrobiłem leczo” (składniki dania zużyte), „jeszcze nie gotowałem leczo”. Wspólna dla domu.
 */
export const pantryUpdateTool: ToolDef<UpdateParams> = {
  name: 'pantry.update',
  capability: 'pantry.update',
  title:
    'Zmień SPIŻARNIĘ (co jest w domu: lodówka, zamrażarka, szafka): have — produkty, które są w domu (nazwy w mianowniku, bez ilości, np. „mleko”, „cebula”; także rozpoznane na zdjęciu lodówki); gone — skończyły się; cooked — tytuł dania z przepisu, które zostało ugotowane (jego składniki schodzą ze spiżarni); notCooked — tytuł dania, którego jeszcze nie ugotowano',
  contexts: ['private_agent', 'household_agent'],
  params: z
    .object({
      have: Names,
      gone: Names,
      cooked: z.string().trim().min(1).max(200).optional(),
      notCooked: z.string().trim().min(1).max(200).optional(),
    })
    .refine(
      (p) => p.have.length + p.gone.length > 0 || p.cooked || p.notCooked,
      'brak zmian',
    ) as unknown as z.ZodType<UpdateParams>,
  requiresApproval: () => false,
  async preview(_ctx, p) {
    const parts = [
      ...(p.have.length ? [`jest: ${p.have.join(', ')}`] : []),
      ...(p.gone.length ? [`skończyło się: ${p.gone.join(', ')}`] : []),
      ...(p.cooked ? [`ugotowane: ${p.cooked}`] : []),
      ...(p.notCooked ? [`jeszcze nieugotowane: ${p.notCooked}`] : []),
    ].join('; ');
    const lines = [
      ...p.have.map((x) => `+ ${x}`),
      ...p.gone.map((x) => `- ${x}`),
      ...(p.cooked ? [`✓ ugotowane: ${p.cooked}`] : []),
    ];
    return {
      summary: `Spiżarnia: ${parts.length > 120 ? `${parts.slice(0, 119)}…` : parts}`,
      target: 'spiżarnia domu',
      scope: 'zmiana stanu',
      // W karcie zgody (np. zdjęcie lodówki): cała rozpoznana lista.
      diff: lines.length > 1 ? lines.join('\n') : null,
    };
  },
  async authorize() {
    return { allow: true, reason: 'household_pantry' };
  },
  async execute(ctx, p) {
    const r = await withUserTx(
      ctx.deps.db,
      { userId: ctx.principal.userId, scope: 'user' },
      async (c) => {
        const uid = ctx.principal.userId;
        const cooked = p.cooked ? await mealCooked(c, ctx.householdId, uid, p.cooked, true) : null;
        const later = p.notCooked
          ? await mealCooked(c, ctx.householdId, uid, p.notCooked, false)
          : null;
        return {
          have: await stock(c, ctx.householdId, uid, p.have, { learn: false }),
          gone: (await useUp(c, ctx.householdId, uid, p.gone)).gone,
          cooked,
          later,
        };
      },
    );
    const parts = [
      ...(r.have.length ? [`W domu: ${r.have.join(', ')}`] : []),
      ...(r.gone.length ? [`skończyło się: ${r.gone.join(', ')}`] : []),
      ...(p.cooked
        ? [
            r.cooked
              ? `ugotowane: ${r.cooked} (składniki zużyte)`
              : `nie ma zaplanowanego dania „${p.cooked}”`,
          ]
        : []),
      ...(p.notCooked
        ? [
            r.later
              ? `${r.later} — jeszcze do ugotowania`
              : `nie ma zaplanowanego dania „${p.notCooked}”`,
          ]
        : []),
    ];
    return { summary: `Spiżarnia: ${parts.join('; ') || 'bez zmian'}`, output: r };
  },
};
