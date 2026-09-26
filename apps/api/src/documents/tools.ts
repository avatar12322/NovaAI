import { decide } from '@nova/permissions';
import type pg from 'pg';
import { z } from 'zod';
import { withUserTx } from '../db/pool';
import { ToolDenied, type ToolContext, type ToolDef } from '../tools/types';
import { allowedDocuments, searchChunks } from './service';
import { locatorLabel } from './text';

/**
 * Narzędzia dokumentów dla agenta: odczyt całego dokumentu (po kolei, fragmentami) i wyszukiwanie w dokumentach.
 * Tylko odczyt, bez zgody; dostęp jak przy automatycznym doborze fragmentów (RLS zakresu kontekstu + polityka
 * `document.read` — NovaAI widzi wyłącznie dokumenty wspólne). Wynik narzędzia zapisany w rozmowie zawiera tylko
 * tytuł i zakres; treść trafia do modelu na żywo w turze uzupełniającej i NIE jest zapisywana w rozmowie —
 * usunięty lub odebrany dokument przestaje być dostępny.
 */
const PARTS_MAX = 12;
const LIVE_CHARS = 24_000;

const actorOf = (ctx: ToolContext) => ({
  userId: ctx.principal.userId,
  activeHouseholdIds: ctx.principal.activeHouseholdIds,
  context: ctx.context,
});
const scopeOf = (ctx: ToolContext) => (ctx.context === 'household_agent' ? 'shared' : 'user');
const inScope = <T>(ctx: ToolContext, fn: (c: pg.PoolClient) => Promise<T>) =>
  withUserTx(ctx.deps.db, { userId: ctx.principal.userId, scope: scopeOf(ctx) }, fn);

interface DocRow {
  id: string;
  owner_user_id: string;
  household_id: string;
  visibility: 'private' | 'shared';
  title: string;
  filename: string;
  chunk_count: number;
}

/** Dokument dozwolony w kontekście narzędzia albo odmowa (bez rozróżnienia „nie istnieje” / „brak dostępu”). */
async function allowedDoc(ctx: ToolContext, c: pg.PoolClient, id: string): Promise<DocRow> {
  const r = await c.query<DocRow>(
    `SELECT id, owner_user_id, household_id, visibility, title, filename, chunk_count
       FROM documents WHERE id = $1 AND chunk_count > 0`,
    [id],
  );
  const d = r.rows[0];
  if (
    !d ||
    d.household_id !== ctx.householdId ||
    !decide(actorOf(ctx), 'document.read', {
      type: 'document',
      id: d.id,
      ownerUserId: d.owner_user_id,
      householdId: d.household_id,
      visibility: d.visibility,
    }).allow
  )
    throw new ToolDenied('document_not_available');
  return d;
}

interface ChunkRow {
  ord: number;
  page: number | null;
  line_start: number | null;
  line_end: number | null;
  heading: string | null;
  content: string;
}

const locator = (h: ChunkRow) =>
  locatorLabel({
    page: h.page,
    lineStart: h.line_start,
    lineEnd: h.line_end,
    heading: h.heading,
  });

/** Treść dla modelu: jawnie oznaczone dane (dokument mógł przygotować ktoś inny), przycięte do limitu. */
function forModel(header: string, parts: Array<{ label: string; content: string }>): string {
  let out = `${header}\n`;
  for (const p of parts) {
    const block = `[${p.label}]\n<<<\n${p.content}\n>>>\n`;
    if (out.length + block.length > LIVE_CHARS) {
      out += '… (dalsza część pominięta — poproś o kolejne fragmenty)\n';
      break;
    }
    out += block;
  }
  return out;
}

type ReadParams = { documentId: string; fromPart: number; parts: number };

const documentsReadTool: ToolDef<ReadParams> = {
  name: 'documents.read',
  capability: 'document.read',
  title:
    'Odczytaj dokument użytkownika (z listy DOKUMENTY) po kolei, fragmentami — np. żeby streścić lub ocenić cały dokument',
  contexts: ['private_agent', 'household_agent'],
  readOnly: true,
  params: z.object({
    documentId: z.uuid(),
    fromPart: z.number().int().min(1).default(1),
    parts: z.number().int().min(1).max(PARTS_MAX).default(8),
  }),
  requiresApproval: () => false,
  async preview(ctx, p) {
    const d = await inScope(ctx, (c) => allowedDoc(ctx, c, p.documentId));
    return {
      summary: `Odczyt dokumentu „${d.title}”`,
      target: d.filename,
      scope: 'odczyt, treść nie jest zapisywana w rozmowie',
    };
  },
  async authorize(ctx, p) {
    try {
      await inScope(ctx, (c) => allowedDoc(ctx, c, p.documentId));
      return { allow: true, reason: 'document_readable' };
    } catch (e) {
      if (e instanceof ToolDenied) return { allow: false, reason: e.reason };
      throw e;
    }
  },
  async execute(ctx, p) {
    const d = await inScope(ctx, (c) => allowedDoc(ctx, c, p.documentId));
    const from = Math.min(p.fromPart, d.chunk_count);
    const to = Math.min(from + p.parts - 1, d.chunk_count);
    return {
      summary: `Dokument „${d.title}”: fragmenty ${from}–${to} z ${d.chunk_count} (treść przekazana modelowi, nie zapisana w rozmowie)`,
      output: {
        documentId: d.id,
        live: { documentId: d.id, fromPart: from, parts: to - from + 1 },
      },
    };
  },
  async live(ctx, params) {
    const p = params as unknown as ReadParams;
    return inScope(ctx, async (c) => {
      const d = await allowedDoc(ctx, c, p.documentId);
      const rows = await c.query<ChunkRow>(
        `SELECT ord, page, line_start, line_end, heading, content FROM document_chunks
          WHERE document_id = $1 AND ord >= $2 AND ord < $3 ORDER BY ord`,
        [d.id, p.fromPart - 1, p.fromPart - 1 + Math.min(p.parts, PARTS_MAX)],
      );
      const last = rows.rows.at(-1);
      return forModel(
        `Dokument „${d.title}” (${d.filename}), fragmenty ${p.fromPart}–${last ? last.ord + 1 : p.fromPart} z ${d.chunk_count}:`,
        rows.rows.map((h) => ({
          label: `fragment ${h.ord + 1}, ${locator(h)}`,
          content: h.content,
        })),
      );
    });
  },
};

type SearchParams = { query: string; documentId?: string; max: number };

async function search(ctx: ToolContext, p: SearchParams) {
  return inScope(ctx, async (c) => {
    const allowed = await allowedDocuments(c, ctx.deps.db, actorOf(ctx), ctx.householdId);
    let ids = [...allowed.keys()];
    if (p.documentId) {
      await allowedDoc(ctx, c, p.documentId);
      ids = ids.filter((id) => id === p.documentId);
    }
    const { rows } = await searchChunks(c, ids, p.query, { limit: p.max });
    return rows.map((h) => ({ ...h, title: allowed.get(h.document_id)?.title ?? '?' }));
  });
}

const documentsSearchTool: ToolDef<SearchParams> = {
  name: 'documents.search',
  capability: 'document.read',
  title:
    'Szukaj słów w dokumentach użytkownika (słowa w języku dokumentu, np. „experience” w CV po angielsku)',
  contexts: ['private_agent', 'household_agent'],
  readOnly: true,
  params: z.object({
    query: z.string().trim().min(1).max(200),
    documentId: z.uuid().optional(),
    max: z.number().int().min(1).max(8).default(6),
  }),
  requiresApproval: () => false,
  async preview(_ctx, p) {
    return {
      summary: `Wyszukiwanie w dokumentach: ${p.query}`,
      target: 'dokumenty',
      scope: 'odczyt, treść nie jest zapisywana w rozmowie',
    };
  },
  async authorize(ctx, p) {
    if (!p.documentId) return { allow: true, reason: 'documents_searchable' };
    try {
      await inScope(ctx, (c) => allowedDoc(ctx, c, p.documentId!));
      return { allow: true, reason: 'document_readable' };
    } catch (e) {
      if (e instanceof ToolDenied) return { allow: false, reason: e.reason };
      throw e;
    }
  },
  async execute(ctx, p) {
    const hits = await search(ctx, p);
    return {
      summary: `Wyszukiwanie w dokumentach „${p.query}”: ${hits.length} fragmentów (treść przekazana modelowi, nie zapisana w rozmowie)`,
      output: {
        count: hits.length,
        live: { query: p.query, max: p.max, ...(p.documentId ? { documentId: p.documentId } : {}) },
      },
    };
  },
  async live(ctx, params) {
    const p = params as unknown as SearchParams;
    const hits = await search(ctx, p);
    if (!hits.length) return `Brak fragmentów pasujących do „${p.query}”.`;
    return forModel(
      `Fragmenty pasujące do „${p.query}”:`,
      hits.map((h) => ({
        label: `„${h.title}”, fragment ${h.ord + 1}, ${locator(h)}`,
        content: h.content,
      })),
    );
  },
};

export const DOCUMENT_TOOLS: ToolDef[] = [
  documentsReadTool as unknown as ToolDef,
  documentsSearchTool as unknown as ToolDef,
];
