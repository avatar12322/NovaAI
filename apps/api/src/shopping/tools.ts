import { z } from 'zod';
import { withUserTx } from '../db/pool';
import type { ToolDef } from '../tools/types';
import { planMeal } from '../pantry/service';
import { addItems, checkByName, listItems, renameByName } from './service';

/**
 * Lista zakupów przez asystenta — w czacie prywatnym i w NovaAI (lista jest wspólna dla domu z natury).
 * „Dodaj mleko i jajka”, „co mamy kupić?”, „kupiłem mleko”. Nazwy pozycji to dane od domowników.
 */
const Names = z.array(z.string().trim().min(1).max(200)).min(1).max(30);

type AddParams = {
  items: string[];
  update: Array<{ from: string; to: string }>;
  maybe: string[];
  meal?: { title: string; uses: string[] };
};
const Item = z.string().trim().min(1).max(200);

export const shoppingAddTool: ToolDef<AddParams> = {
  name: 'shopping.add',
  capability: 'shopping.add',
  title:
    'Dodaj do wspólnej listy zakupów domu: items — do kupienia (jedna pozycja na produkt, z ilością, np. „mleko 1 l”, „jajka 5 szt.”); update — zmiana pozycji już będących na LIŚCIE ZAKUPÓW, gdy ten sam produkt dochodzi jeszcze raz: from — obecna treść, to — nowa z sumą ilości („jajka 3 szt.” → „jajka 5 szt.”); maybe — produkty, które według SPIŻARNI pewnie się kończą (użytkownik sprawdzi i dotknie „Kup” albo „Mam”); meal — przy przepisie: title — nazwa dania, uses — produkty (mianownik), które danie zużyje w całości (mięso, warzywa kupione do dania; bez mąki, oleju, przypraw z większych opakowań). Bez wody, soli i pieprzu',
  contexts: ['private_agent', 'household_agent'],
  params: z
    .object({
      items: z.array(Item).max(40).default([]),
      update: z
        .array(z.object({ from: Item, to: Item }))
        .max(40)
        .default([]),
      maybe: z.array(Item).max(40).default([]),
      meal: z
        .object({
          title: z.string().trim().min(1).max(200),
          uses: z.array(z.string().trim().min(1).max(120)).max(60).default([]),
        })
        .optional(),
    })
    .refine(
      (p) => p.items.length + p.update.length + p.maybe.length > 0,
      'items, update albo maybe',
    ) as unknown as z.ZodType<AddParams>,
  requiresApproval: () => false,
  async preview(_ctx, p) {
    const all = [...p.items, ...p.update.map((u) => u.to)].join(', ');
    const lines = [
      ...p.items.map((i) => `+ ${i}`),
      ...p.update.map((u) => `~ ${u.from} → ${u.to}`),
      ...p.maybe.map((i) => `? ${i} — pewnie masz, sprawdzisz na liście`),
    ];
    return {
      summary: `Lista zakupów${p.meal ? ` (${p.meal.title})` : ''}: ${all.length > 120 ? `${all.slice(0, 119)}…` : all || p.maybe.join(', ')}`,
      target: 'wspólna lista zakupów',
      scope: 'dodanie pozycji',
      // W karcie zgody: cała lista — co dojdzie, co się zmieni, co pewnie jest w domu.
      diff: lines.length > 1 ? lines.join('\n') : null,
    };
  },
  async authorize() {
    return { allow: true, reason: 'household_list' };
  },
  async execute(ctx, p) {
    const uid = ctx.principal.userId;
    const r = await withUserTx(ctx.deps.db, { userId: uid, scope: 'user' }, async (c) => {
      const renamed = await renameByName(c, ctx.householdId, uid, p.update);
      const added = await addItems(c, ctx.householdId, uid, [
        ...p.items,
        ...renamed.notFound.map((x) => x.to),
      ]);
      const unsure = p.maybe.length
        ? await addItems(c, ctx.householdId, uid, p.maybe, true)
        : { added: [], skipped: [] };
      // Danie z przepisu: jego składniki zejdą ze spiżarni po ugotowaniu (albo po kilku dniach).
      if (p.meal) await planMeal(c, ctx.householdId, p.meal.title, p.meal.uses);
      return { ...added, maybe: unsure.added, changed: renamed.changed };
    });
    const parts = [
      r.added.length ? `Dodano do listy zakupów: ${r.added.join(', ')}` : 'Nic nowego na liście',
    ];
    if (r.changed.length) parts.push(`zmieniono: ${r.changed.join(', ')}`);
    if (r.maybe.length) parts.push(`do sprawdzenia (pewnie masz): ${r.maybe.join(', ')}`);
    if (r.skipped.length) parts.push(`już było: ${r.skipped.join(', ')}`);
    return {
      summary: parts.join('; '),
      output: { added: r.added, changed: r.changed, maybe: r.maybe, skipped: r.skipped },
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
    const open = items
      .filter((i) => !i.checked)
      .map((i) => (i.maybe ? `${i.text} (pewnie jest w domu — do sprawdzenia)` : i.text));
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
