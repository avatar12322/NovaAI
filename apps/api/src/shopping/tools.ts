import { z } from 'zod';
import { withUserTx } from '../db/pool';
import type { ToolDef } from '../tools/types';
import { addItems, checkByName, listItems } from './service';

/**
 * Lista zakupów przez asystenta — w czacie prywatnym i w NovaAI (lista jest wspólna dla domu z natury).
 * „Dodaj mleko i jajka”, „co mamy kupić?”, „kupiłem mleko”. Nazwy pozycji to dane od domowników.
 */
const Names = z.array(z.string().trim().min(1).max(200)).min(1).max(30);

export const shoppingAddTool: ToolDef<{ items: string[] }> = {
  name: 'shopping.add',
  capability: 'shopping.add',
  title: 'Dodaj pozycje do wspólnej listy zakupów domu (każda pozycja osobno, np. „mleko 2 l”)',
  contexts: ['private_agent', 'household_agent'],
  params: z.object({ items: Names }),
  requiresApproval: () => false,
  async preview(_ctx, p) {
    return {
      summary: `Lista zakupów: ${p.items.join(', ').slice(0, 120)}`,
      target: 'wspólna lista zakupów',
      scope: 'dodanie pozycji',
    };
  },
  async authorize() {
    return { allow: true, reason: 'household_list' };
  },
  async execute(ctx, p) {
    const r = await withUserTx(ctx.deps.db, { userId: ctx.principal.userId, scope: 'user' }, (c) =>
      addItems(c, ctx.householdId, ctx.principal.userId, p.items),
    );
    const parts = [
      r.added.length ? `Dodano do listy zakupów: ${r.added.join(', ')}` : 'Nic nowego na liście',
    ];
    if (r.skipped.length) parts.push(`już było: ${r.skipped.join(', ')}`);
    return { summary: parts.join('; '), output: { added: r.added, skipped: r.skipped } };
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
