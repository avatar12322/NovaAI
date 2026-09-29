import { z } from 'zod';
import { withUserTx } from '../db/pool';
import type { ToolDef } from '../tools/types';
import { addItems, checkByName, listItems, renameByName } from './service';

/**
 * Lista zakupów przez asystenta — w czacie prywatnym i w NovaAI (lista jest wspólna dla domu z natury).
 * „Dodaj mleko i jajka”, „co mamy kupić?”, „kupiłem mleko”. Nazwy pozycji to dane od domowników.
 */
const Names = z.array(z.string().trim().min(1).max(200)).min(1).max(30);

type AddParams = { items: string[]; update: Array<{ from: string; to: string }> };

export const shoppingAddTool: ToolDef<AddParams> = {
  name: 'shopping.add',
  capability: 'shopping.add',
  title:
    'Dodaj do wspólnej listy zakupów domu: items — nowe pozycje (jedna pozycja na produkt, z ilością, np. „mleko 1 l”, „jajka 5 szt.”); update — zmiana pozycji już będących na LIŚCIE ZAKUPÓW, gdy ten sam produkt dochodzi jeszcze raz: from — obecna treść, to — nowa z sumą ilości (np. „jajka 3 szt.” → „jajka 5 szt.”). Bez wody, soli i pieprzu',
  contexts: ['private_agent', 'household_agent'],
  params: z
    .object({
      items: z.array(z.string().trim().min(1).max(200)).max(40).default([]),
      update: z
        .array(
          z.object({
            from: z.string().trim().min(1).max(200),
            to: z.string().trim().min(1).max(200),
          }),
        )
        .max(40)
        .default([]),
    })
    .refine(
      (p) => p.items.length + p.update.length > 0,
      'items albo update',
    ) as unknown as z.ZodType<AddParams>,
  requiresApproval: () => false,
  async preview(_ctx, p) {
    const all = [...p.items, ...p.update.map((u) => u.to)].join(', ');
    return {
      summary: `Lista zakupów: ${all.length > 120 ? `${all.slice(0, 119)}…` : all}`,
      target: 'wspólna lista zakupów',
      scope: 'dodanie pozycji',
      // W karcie zgody: cała lista — co dojdzie i co się zmieni.
      diff:
        p.items.length + p.update.length > 1
          ? [...p.items.map((i) => `+ ${i}`), ...p.update.map((u) => `~ ${u.from} → ${u.to}`)].join(
              '\n',
            )
          : null,
    };
  },
  async authorize() {
    return { allow: true, reason: 'household_list' };
  },
  async execute(ctx, p) {
    const r = await withUserTx(
      ctx.deps.db,
      { userId: ctx.principal.userId, scope: 'user' },
      async (c) => {
        const renamed = await renameByName(c, ctx.householdId, ctx.principal.userId, p.update);
        const added = await addItems(c, ctx.householdId, ctx.principal.userId, [
          ...p.items,
          ...renamed.notFound.map((x) => x.to),
        ]);
        return { ...added, changed: renamed.changed };
      },
    );
    const parts = [
      r.added.length ? `Dodano do listy zakupów: ${r.added.join(', ')}` : 'Nic nowego na liście',
    ];
    if (r.changed.length) parts.push(`zmieniono: ${r.changed.join(', ')}`);
    if (r.skipped.length) parts.push(`już było: ${r.skipped.join(', ')}`);
    return {
      summary: parts.join('; '),
      output: { added: r.added, changed: r.changed, skipped: r.skipped },
    };
  },
};

export const shoppingListTool: ToolDef<Record<string, never>> = {
  name: 'shopping.list',
  capability: 'shopping.list',
  title: 'Pokaż wspólną listę zakupów (co zostało do kupienia)',
  contexts: ['private_agent', 'household_agent'],
  readOnly: true,
  params: z.object({}) as unknown as z.ZodType<Record<string, never>>,
  requiresApproval: () => false,
  async preview() {
    return { summary: 'Lista zakupów', target: 'wspólna lista zakupów', scope: 'odczyt' };
  },
  async authorize() {
    return { allow: true, reason: 'household_list' };
  },
  async execute(ctx) {
    const items = await withUserTx(
      ctx.deps.db,
      { userId: ctx.principal.userId, scope: 'user' },
      (c) => listItems(c, ctx.householdId),
    );
    const open = items.filter((i) => !i.checked).map((i) => i.text);
    return {
      summary: open.length ? `Do kupienia (${open.length})` : 'Lista zakupów jest pusta',
      output: { shopping: open },
    };
  },
};

export const shoppingCheckTool: ToolDef<{ items: string[] }> = {
  name: 'shopping.check',
  capability: 'shopping.check',
  title: 'Odhacz kupione pozycje na liście zakupów (podaj ich nazwy, np. „mleko”)',
  contexts: ['private_agent', 'household_agent'],
  params: z.object({ items: Names }),
  requiresApproval: () => false,
  async preview(_ctx, p) {
    return {
      summary: `Kupione: ${p.items.join(', ').slice(0, 120)}`,
      target: 'wspólna lista zakupów',
      scope: 'odhaczenie',
    };
  },
  async authorize() {
    return { allow: true, reason: 'household_list' };
  },
  async execute(ctx, p) {
    const r = await withUserTx(ctx.deps.db, { userId: ctx.principal.userId, scope: 'user' }, (c) =>
      checkByName(c, ctx.householdId, ctx.principal.userId, p.items),
    );
    const parts = [r.checked.length ? `Odhaczono: ${r.checked.join(', ')}` : 'Nic nie odhaczono'];
    if (r.notFound.length) parts.push(`nie ma na liście: ${r.notFound.join(', ')}`);
    return { summary: parts.join('; '), output: { checked: r.checked, notFound: r.notFound } };
  },
};

export const SHOPPING_TOOLS = [shoppingAddTool, shoppingListTool, shoppingCheckTool];
