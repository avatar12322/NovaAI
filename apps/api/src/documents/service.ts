import {
  DOCUMENT_LIMITS,
  type DocumentFormat,
  type DocumentInfo,
  type DocumentSearchHit,
} from '@nova/contracts';
import { decide, type Actor } from '@nova/permissions';
import type pg from 'pg';
import { writeAudit } from '../audit';
import { withSystemTx, type Db } from '../db/pool';
import { emitEvent } from '../events';
import { createTask } from '../queue/tasks';
import type { TaskKindDef } from '../queue/runner';
import { ToolDenied } from '../tools/types';
import { extractDocument } from './extract';
import {
  DocumentError,
  normalize,
  queryTerms,
  snippet,
  titleFromFilename,
  toTsQuery,
} from './text';

interface DocRow {
  id: string;
  title: string;
  filename: string;
  format: DocumentFormat;
  visibility: 'private' | 'shared';
  size_bytes: number;
  status: DocumentInfo['status'];
  error: string | null;
  page_count: number | null;
  chunk_count: number;
  owner_user_id: string;
  household_id: string;
  owner_name: string | null;
  created_at: string;
  indexed_at: string | null;
}

export const DOC_SELECT = `
  SELECT d.id, d.title, d.filename, d.format, d.visibility, d.size_bytes, d.status, d.error, d.page_count,
         d.chunk_count, d.owner_user_id, d.household_id, u.display_name AS owner_name, d.created_at, d.indexed_at
    FROM documents d LEFT JOIN users u ON u.id = d.owner_user_id`;

export const toDocument = (r: DocRow, me: string): DocumentInfo => ({
  id: r.id,
  title: r.title,
  filename: r.filename,
  format: r.format,
  visibility: r.visibility,
  sizeBytes: r.size_bytes,
  status: r.status,
  error: r.error,
  pageCount: r.page_count,
  chunkCount: r.chunk_count,
  ownerUserId: r.owner_user_id,
  ownerName: r.owner_name,
  isMine: r.owner_user_id === me,
  createdAt: r.created_at,
  indexedAt: r.indexed_at,
});

export async function fetchDocument(
  c: pg.PoolClient,
  id: string,
  me: string,
): Promise<DocumentInfo | null> {
  const r = await c.query<DocRow>(`${DOC_SELECT} WHERE d.id = $1`, [id]);
  return r.rows[0] ? toDocument(r.rows[0], me) : null;
}

export class DocumentQuotaError extends Error {
  constructor(
    public readonly code: 'too_many' | 'storage_full' | 'duplicate',
    message: string,
    public readonly existingId?: string,
  ) {
    super(message);
  }
}

/** Zadanie indeksowania — zawsze prywatne (tytuł zawiera nazwę pliku, a dokument może zostać odebrany z „wspólnych”). */
async function enqueueIndex(
  c: pg.PoolClient,
  doc: { id: string; householdId: string; title: string; version: number },
  requestId: string | null,
): Promise<string> {
  const taskId = await createTask(c, {
    householdId: doc.householdId,
    visibility: 'private',
    kind: 'document.index',
    title: `Indeksowanie: ${doc.title}`.slice(0, 200),
    input: { documentId: doc.id, version: doc.version },
    steps: [{ key: 'index', title: 'Odczyt tekstu i podział na fragmenty', kind: 'note' }],
    requestId,
    maxAttempts: 2,
  });
  await c.query('UPDATE documents SET task_id = $2 WHERE id = $1', [doc.id, taskId]);
  return taskId;
}

/**
 * Zapis nowego dokumentu w transakcji użytkownika (RLS): limity liczby i rozmiaru per osoba,
 * wykrycie duplikatu (ten sam plik u tej samej osoby), oryginał + zadanie indeksowania w kolejce.
 */
export async function createDocument(
  c: pg.PoolClient,
  a: {
    householdId: string;
    userId: string;
    filename: string;
    format: DocumentFormat;
    visibility: 'private' | 'shared';
    bytes: Buffer;
    sha256: string;
    requestId: string | null;
  },
): Promise<{ document: DocumentInfo; taskId: string }> {
  // Serializacja zapisów jednej osoby — limity nie mogą zostać obejście równoległymi żądaniami.
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('nova-doc:' || nova_uid()::text))`);
  const dup = await c.query<{ id: string }>(
    'SELECT id FROM documents WHERE owner_user_id = nova_uid() AND sha256 = $1',
    [a.sha256],
  );
  if (dup.rows[0]) {
    throw new DocumentQuotaError(
      'duplicate',
      'Ten plik jest już w Twoich dokumentach',
      dup.rows[0].id,
    );
  }
  const usage = await c.query<{ n: number; bytes: string }>(
    `SELECT count(*)::int AS n, coalesce(sum(size_bytes), 0)::bigint AS bytes
       FROM documents WHERE owner_user_id = nova_uid()`,
  );
  const n = usage.rows[0]?.n ?? 0;
  const used = Number(usage.rows[0]?.bytes ?? 0);
  if (n >= DOCUMENT_LIMITS.maxDocumentsPerUser) {
    throw new DocumentQuotaError(
      'too_many',
      `Limit ${DOCUMENT_LIMITS.maxDocumentsPerUser} dokumentów na osobę — usuń niepotrzebne`,
    );
  }
  if (used + a.bytes.length > DOCUMENT_LIMITS.maxTotalBytesPerUser) {
    throw new DocumentQuotaError(
      'storage_full',
      `Brak miejsca: limit ${Math.round(DOCUMENT_LIMITS.maxTotalBytesPerUser / 1024 / 1024)} MB na osobę`,
    );
  }
  const title = titleFromFilename(a.filename);
  const ins = await c.query<{ id: string; index_version: number }>(
    `INSERT INTO documents (household_id, owner_user_id, visibility, title, filename, format, size_bytes, sha256)
     VALUES ($1, nova_uid(), $2, $3, $4, $5, $6, $7) RETURNING id, index_version`,
    [a.householdId, a.visibility, title, a.filename, a.format, a.bytes.length, a.sha256],
  );
  const { id, index_version } = ins.rows[0]!;
  await c.query('INSERT INTO document_blobs (document_id, content) VALUES ($1, $2)', [id, a.bytes]);
  const taskId = await enqueueIndex(
    c,
    { id, householdId: a.householdId, title, version: index_version },
    a.requestId,
  );
  await emitEvent(c, {
    householdId: a.householdId,
    ownerUserId: a.userId,
    visibility: a.visibility,
    type: 'document.updated',
    payload: { documentId: id, status: 'pending' },
  });
  return { document: (await fetchDocument(c, id, a.userId))!, taskId };
}

/** Ponowne indeksowanie: nowa wersja (stare zadania przestają mieć znaczenie), stare fragmenty działają do końca. */
export async function reindexDocument(
  c: pg.PoolClient,
  id: string,
  userId: string,
  requestId: string | null,
): Promise<{ document: DocumentInfo; taskId: string }> {
  const r = await c.query<{
    household_id: string;
    title: string;
    index_version: number;
    visibility: 'private' | 'shared';
  }>(
    `UPDATE documents SET status = 'pending', error = NULL, index_version = index_version + 1, updated_at = now()
      WHERE id = $1 RETURNING household_id, title, index_version, visibility`,
    [id],
  );
  const d = r.rows[0];
  if (!d) throw new ToolDenied('not_found');
  const taskId = await enqueueIndex(
    c,
    { id, householdId: d.household_id, title: d.title, version: d.index_version },
    requestId,
  );
  await emitEvent(c, {
    householdId: d.household_id,
    ownerUserId: userId,
    visibility: d.visibility,
    type: 'document.updated',
    payload: { documentId: id, status: 'pending' },
  });
  return { document: (await fetchDocument(c, id, userId))!, taskId };
}

/** Zmiana widoczności dokumentu i jego fragmentów w jednej transakcji (natychmiastowe odebranie dostępu). */
export async function setDocumentVisibility(
  c: pg.PoolClient,
  id: string,
  userId: string,
  visibility: 'private' | 'shared',
): Promise<DocumentInfo> {
  const cur = await c.query<{ household_id: string; visibility: string }>(
    'SELECT household_id, visibility FROM documents WHERE id = $1 FOR UPDATE',
    [id],
  );
  const row = cur.rows[0];
  if (!row) throw new ToolDenied('not_found');
  if (row.visibility !== visibility) {
    await c.query('UPDATE documents SET visibility = $2, updated_at = now() WHERE id = $1', [
      id,
      visibility,
    ]);
    await c.query('UPDATE document_chunks SET visibility = $2 WHERE document_id = $1', [
      id,
      visibility,
    ]);
    // Zdarzenie w obu przestrzeniach: pozostali domownicy odświeżą listy (także przy odebraniu).
    await emitEvent(c, {
      householdId: row.household_id,
      ownerUserId: userId,
      visibility: 'shared',
      type: 'document.updated',
      payload: { documentId: id, visibility: visibility === 'shared' ? 'shared' : 'removed' },
    });
  }
  return (await fetchDocument(c, id, userId))!;
}

async function markFailed(
  db: Db,
  doc: {
    id: string;
    household_id: string;
    owner_user_id: string;
    visibility: 'private' | 'shared';
  },
  version: number,
  message: string,
  taskId: string,
): Promise<void> {
  await withSystemTx(db, async (c) => {
    const r = await c.query(
      `UPDATE documents SET status = 'failed', error = $3, chunk_count = 0, page_count = NULL, updated_at = now()
        WHERE id = $1 AND index_version = $2`,
      [doc.id, version, message],
    );
    if (r.rowCount !== 1) return;
    await c.query('DELETE FROM document_chunks WHERE document_id = $1', [doc.id]);
    await emitEvent(c, {
      householdId: doc.household_id,
      ownerUserId: doc.owner_user_id,
      visibility: doc.visibility,
      taskId,
      type: 'document.updated',
      payload: { documentId: doc.id, status: 'failed' },
    });
  });
}

/**
 * Indeksowanie (kolejka, bez modelu i kosztów): odczyt oryginału, tekst (PDF w osobnym wątku), fragmenty.
 * Błędy treści kończą się statusem `failed` z komunikatem dla użytkownika — bez ponawiania.
 */
export const documentIndexKind: TaskKindDef = {
  context: async () => 'user',
  steps: {
    index: async (x) => {
      const documentId = String(x.task.input.documentId ?? '');
      const version = Number(x.task.input.version ?? 0);
      const r = await x.deps.db.owner.query<{
        id: string;
        owner_user_id: string;
        household_id: string;
        visibility: 'private' | 'shared';
        format: DocumentFormat;
        index_version: number;
        content: Buffer;
      }>(
        `SELECT d.id, d.owner_user_id, d.household_id, d.visibility, d.format, d.index_version, b.content
           FROM documents d JOIN document_blobs b ON b.document_id = d.id WHERE d.id = $1`,
        [documentId],
      );
      const doc = r.rows[0];
      if (!doc) return { skipped: 'deleted' };
      if (doc.owner_user_id !== x.principal.userId) throw new ToolDenied('not_owner');
      if (doc.index_version !== version) return { skipped: 'superseded' };

      await x.deps.db.owner.query(
        `UPDATE documents SET status = 'indexing', updated_at = now() WHERE id = $1 AND index_version = $2`,
        [doc.id, version],
      );
      await x.progress(10);
      let extracted;
      try {
        extracted = await extractDocument(doc.format, doc.content);
      } catch (err) {
        if (err instanceof DocumentError) {
          await markFailed(x.deps.db, doc, version, err.message, x.task.id);
          return { failed: err.code };
        }
        await markFailed(
          x.deps.db,
          doc,
          version,
          'Nie udało się zindeksować pliku — spróbuj ponownie',
          x.task.id,
        );
        throw err;
      }
      await x.progress(70);

      const chunks = extracted.chunks.slice(0, 5000);
      const done = await withSystemTx(x.deps.db, async (c) => {
        const cur = await c.query<{
          index_version: number;
          visibility: 'private' | 'shared';
          household_id: string;
          owner_user_id: string;
        }>(
          'SELECT index_version, visibility, household_id, owner_user_id FROM documents WHERE id = $1 FOR UPDATE',
          [doc.id],
        );
        const now = cur.rows[0];
        if (!now || now.index_version !== version) return false;
        await c.query('DELETE FROM document_chunks WHERE document_id = $1', [doc.id]);
        await c.query(
          `INSERT INTO document_chunks (document_id, household_id, owner_user_id, visibility, ord, page,
                                        line_start, line_end, heading, content, search_text)
           SELECT $1, $2, $3, $4, t.ord, t.page, t.line_start, t.line_end, t.heading, t.content, t.search_text
             FROM unnest($5::int[], $6::int[], $7::int[], $8::int[], $9::text[], $10::text[], $11::text[])
                  AS t(ord, page, line_start, line_end, heading, content, search_text)`,
          [
            doc.id,
            now.household_id,
            now.owner_user_id,
            now.visibility,
            chunks.map((_, i) => i),
            chunks.map((ch) => ch.page),
            chunks.map((ch) => ch.lineStart),
            chunks.map((ch) => ch.lineEnd),
            chunks.map((ch) => ch.heading),
            chunks.map((ch) => ch.content),
            chunks.map((ch) => normalize(`${ch.heading ? `${ch.heading}\n` : ''}${ch.content}`)),
          ],
        );
        await c.query(
          `UPDATE documents SET status = 'ready', error = NULL, page_count = $2, chunk_count = $3, char_count = $4,
                  indexed_at = now(), updated_at = now() WHERE id = $1`,
          [doc.id, extracted.pageCount, chunks.length, extracted.charCount],
        );
        await emitEvent(c, {
          householdId: now.household_id,
          ownerUserId: now.owner_user_id,
          visibility: now.visibility,
          taskId: x.task.id,
          type: 'document.updated',
          payload: { documentId: doc.id, status: 'ready' },
        });
        return true;
      });
      return done
        ? {
            chunks: chunks.length,
            pages: extracted.pageCount,
            encoding: extracted.encoding ?? null,
          }
        : { skipped: 'superseded' };
    },
  },
};

interface ChunkHitRow {
  document_id: string;
  ord: number;
  page: number | null;
  line_start: number | null;
  line_end: number | null;
  heading: string | null;
  content: string;
  matched: number;
}

/**
 * Dokumenty, z których WOLNO pobrać fragmenty w danym kontekście — decyzja PRZED pobraniem treści.
 * Zapytanie działa pod RLS kontekstu (NovaAI => scope 'shared'), a każdy dokument jest dodatkowo
 * sprawdzany polityką aplikacji; rozbieżność jest audytowana i dokument pomijany.
 */
export interface AllowedDocument {
  title: string;
  filename: string;
  format: DocumentFormat;
  visibility: 'private' | 'shared';
  pageCount: number | null;
  chunkCount: number;
}

export async function allowedDocuments(
  c: pg.PoolClient,
  db: Db,
  actor: Actor,
  householdId: string,
): Promise<Map<string, AllowedDocument>> {
  const r = await c.query<{
    id: string;
    owner_user_id: string;
    household_id: string;
    visibility: 'private' | 'shared';
    title: string;
    filename: string;
    format: DocumentFormat;
    page_count: number | null;
    chunk_count: number;
  }>(
    `SELECT id, owner_user_id, household_id, visibility, title, filename, format, page_count, chunk_count
       FROM documents WHERE household_id = $1 AND chunk_count > 0
      ORDER BY created_at DESC, id`,
    [householdId],
  );
  const out = new Map<string, AllowedDocument>();
  let dropped = 0;
  for (const d of r.rows) {
    const decision = decide(actor, 'document.read', {
      type: 'document',
      id: d.id,
      ownerUserId: d.owner_user_id,
      householdId: d.household_id,
      visibility: d.visibility,
    });
    if (decision.allow)
      out.set(d.id, {
        title: d.title,
        filename: d.filename,
        format: d.format,
        visibility: d.visibility,
        pageCount: d.page_count,
        chunkCount: d.chunk_count,
      });
    else dropped++;
  }
  if (dropped > 0) {
    await writeAudit(db, {
      actorKind: actor.context === 'user' ? 'user' : 'agent',
      actorUserId: actor.userId,
      ownerUserId: actor.userId,
      householdId,
      source: 'api',
      action: 'document.search.policy_mismatch',
      outcome: 'deny',
      details: { dropped, context: actor.context },
    });
  }
  return out;
}

/** Wyszukiwanie fragmentów WYŁĄCZNIE w podanych (już dozwolonych) dokumentach; wynik posortowany wg trafności. */
export async function searchChunks(
  c: pg.PoolClient,
  documentIds: string[],
  query: string,
  opts: { limit: number; minMatched?: number },
): Promise<{ rows: ChunkHitRow[]; terms: ReturnType<typeof queryTerms> }> {
  const terms = queryTerms(query);
  if (!terms.length || !documentIds.length) return { rows: [], terms };
  // Trafność: liczba różnych termów z zapytania, ważona rzadkością termu (IDF liczone wyłącznie
  // w dozwolonych dokumentach) — „wypowiedzenie” waży więcej niż słowo obecne na każdej stronie.
  const r = await c.query<ChunkHitRow>(
    `WITH q AS (SELECT to_tsquery('simple', $1) AS query),
          terms AS (SELECT term FROM unnest($3::text[]) AS t(term)),
          total AS (SELECT count(*)::float AS n FROM document_chunks WHERE document_id = ANY($2::uuid[])),
          df AS (
            SELECT terms.term,
                   (SELECT count(*) FROM document_chunks ch
                     WHERE ch.document_id = ANY($2::uuid[]) AND ch.tsv @@ to_tsquery('simple', terms.term))::float AS df
              FROM terms),
          cand AS (
            SELECT ch.document_id, ch.ord, ch.page, ch.line_start, ch.line_end, ch.heading, ch.content, ch.tsv,
                   ts_rank_cd(ch.tsv, q.query) AS rank
              FROM document_chunks ch, q
             WHERE ch.document_id = ANY($2::uuid[]) AND ch.tsv @@ q.query
             ORDER BY rank DESC LIMIT 200),
          scored AS (
            SELECT cand.*,
                   (SELECT count(*)::int FROM df WHERE cand.tsv @@ to_tsquery('simple', df.term)) AS matched,
                   (SELECT coalesce(sum(ln(1 + total.n / greatest(df.df, 1))), 0)
                      FROM df, total WHERE cand.tsv @@ to_tsquery('simple', df.term)) AS weight
              FROM cand)
     SELECT document_id, ord, page, line_start, line_end, heading, content, matched
       FROM scored WHERE matched >= $5
      ORDER BY weight DESC, rank DESC, ord LIMIT $4`,
    [
      toTsQuery(terms),
      documentIds,
      terms.map((t) => toTsQuery([t])),
      opts.limit,
      opts.minMatched ?? 1,
    ],
  );
  return { rows: r.rows, terms };
}

/** Wyszukiwanie dla użytkownika (widok Dokumenty): własne prywatne + wspólne dokumenty domu. */
export async function searchForUser(
  c: pg.PoolClient,
  db: Db,
  actor: Actor,
  householdId: string,
  query: string,
  limit: number,
): Promise<DocumentSearchHit[]> {
  const allowed = await allowedDocuments(c, db, actor, householdId);
  const { rows, terms } = await searchChunks(c, [...allowed.keys()], query, { limit });
  return rows.map((h) => {
    const d = allowed.get(h.document_id)!;
    return {
      documentId: h.document_id,
      title: d.title,
      filename: d.filename,
      format: d.format,
      visibility: d.visibility,
      ord: h.ord,
      page: h.page,
      lineStart: h.line_start,
      lineEnd: h.line_end,
      heading: h.heading,
      snippet: snippet(h.content, terms),
      matchedTerms: h.matched,
    };
  });
}
