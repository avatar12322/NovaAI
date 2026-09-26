import {
  DOCUMENT_LIMITS,
  ListDocumentsQuery,
  SearchDocumentsQuery,
  UploadDocumentQuery,
  type DocumentChunk,
} from '@nova/contracts';
import { decideCreate } from '@nova/permissions';
import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { actorFor, authorize, requireAuth } from '../access';
import { writeAudit } from '../audit';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { emitEvent } from '../events';
import { decodeCursor, pageResult } from '../lib/cursor';
import { forbidden, HttpError, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import {
  createDocument,
  DOC_SELECT,
  DocumentQuotaError,
  fetchDocument,
  reindexDocument,
  searchForUser,
  setDocumentVisibility,
  toDocument,
} from './service';
import { cleanFilename, detectFormat, DocumentError } from './text';

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
};

/** Nagłówek Content-Disposition z bezpieczną nazwą (RFC 6266/5987). */
function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const documentRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    // Plik przychodzi jako surowe bajty (bez multipart); typ ustalamy z rozszerzenia i treści.
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: DOCUMENT_LIMITS.maxBytes },
      (_req, body, done) => done(null, body),
    );

    const audit = (
      req: FastifyRequest,
      action: string,
      documentId: string,
      ownerUserId: string,
      householdId: string | null,
      details?: Record<string, unknown>,
    ) =>
      writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: req.auth!.userId,
        ownerUserId,
        householdId,
        source: 'api',
        action,
        resourceType: 'document',
        resourceId: documentId,
        outcome: 'ok',
        correlationId: req.id,
        details,
      });

    app.get('/documents', async (req) => {
      const auth = requireAuth(req);
      const q = parse(ListDocumentsQuery, req.query);
      const cursor = decodeCursor(q.cursor);
      const rows = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const params: unknown[] = [q.limit + 1];
        const conds: string[] = [];
        if (q.space === 'private') {
          conds.push(`d.visibility = 'private'`, 'd.owner_user_id = nova_uid()');
        } else {
          params.push(auth.householdId);
          conds.push(`d.visibility = 'shared'`, `d.household_id = $${params.length}`);
        }
        if (cursor) {
          params.push(cursor.ts, cursor.id);
          conds.push(
            `(d.created_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
          );
        }
        const r = await c.query(
          `${DOC_SELECT} WHERE ${conds.join(' AND ')} ORDER BY d.created_at DESC, d.id DESC LIMIT $1`,
          params,
        );
        return r.rows.map((row) => toDocument(row as never, auth.userId));
      });
      return pageResult(rows, q.limit, (d) => d.createdAt);
    });

    app.post('/documents', { bodyLimit: DOCUMENT_LIMITS.maxBytes }, async (req, reply) => {
      const auth = requireAuth(req);
      const q = parse(UploadDocumentQuery, req.query);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      const d = decideCreate(actorFor(auth), 'document.create', {
        householdId: auth.householdId,
        visibility: q.space,
      });
      if (!d.allow) throw forbidden();
      if (!Buffer.isBuffer(req.body)) {
        throw new HttpError(
          415,
          'unsupported_media_type',
          'Wyślij plik jako application/octet-stream',
        );
      }
      const bytes = req.body;
      if (bytes.length === 0) throw new HttpError(400, 'empty', 'Plik jest pusty');
      const filename = cleanFilename(q.name);
      if (!filename) throw new HttpError(400, 'bad_request', 'Brak nazwy pliku');
      let format;
      try {
        format = detectFormat(filename, bytes);
      } catch (err) {
        if (err instanceof DocumentError) throw new HttpError(415, err.code, err.message);
        throw err;
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      try {
        const created = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
          createDocument(c, {
            householdId: auth.householdId!,
            userId: auth.userId,
            filename,
            format,
            visibility: q.space,
            bytes,
            sha256,
            requestId: req.id,
          }),
        );
        await audit(req, 'document.create', created.document.id, auth.userId, auth.householdId, {
          format,
          sizeBytes: bytes.length,
          visibility: q.space,
        });
        deps.kickQueue();
        return reply.status(201).send(created);
      } catch (err) {
        if (err instanceof DocumentQuotaError) {
          throw new HttpError(
            err.code === 'duplicate' ? 409 : 413,
            err.code,
            err.message,
            err.existingId ? { documentId: err.existingId } : undefined,
          );
        }
        throw err;
      }
    });

    app.get('/documents/search', async (req) => {
      const auth = requireAuth(req);
      const q = parse(SearchDocumentsQuery, req.query);
      if (!auth.householdId) return { items: [] };
      const items = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
        searchForUser(c, deps.db, actorFor(auth), auth.householdId!, q.q, q.limit),
      );
      return { items };
    });

    app.get<{ Params: { id: string } }>('/documents/:id', async (req) => {
      const auth = requireAuth(req);
      await authorize(deps.db, req, 'document', req.params.id, 'document.read');
      const doc = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
        fetchDocument(c, req.params.id, auth.userId),
      );
      if (!doc) throw notFound('Document');
      return doc;
    });

    app.get<{ Params: { id: string; ord: string } }>(
      '/documents/:id/chunks/:ord',
      async (req): Promise<DocumentChunk> => {
        const auth = requireAuth(req);
        await authorize(deps.db, req, 'document', req.params.id, 'document.read');
        const ord = Number(req.params.ord);
        if (!Number.isInteger(ord) || ord < 0) throw notFound('Fragment');
        const r = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
          c.query<{
            ord: number;
            page: number | null;
            line_start: number | null;
            line_end: number | null;
            heading: string | null;
            content: string;
            chunk_count: number;
          }>(
            `SELECT ch.ord, ch.page, ch.line_start, ch.line_end, ch.heading, ch.content, d.chunk_count
               FROM document_chunks ch JOIN documents d ON d.id = ch.document_id
              WHERE ch.document_id = $1 AND ch.ord = $2`,
            [req.params.id, ord],
          ),
        );
        const row = r.rows[0];
        if (!row) throw notFound('Fragment');
        return {
          documentId: req.params.id,
          ord: row.ord,
          page: row.page,
          lineStart: row.line_start,
          lineEnd: row.line_end,
          heading: row.heading,
          content: row.content,
          chunkCount: row.chunk_count,
        };
      },
    );

    app.get<{ Params: { id: string } }>('/documents/:id/file', async (req, reply) => {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'document', req.params.id, 'document.read');
      const r = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
        c.query<{ content: Buffer; filename: string; format: string }>(
          `SELECT b.content, d.filename, d.format FROM document_blobs b JOIN documents d ON d.id = b.document_id
            WHERE b.document_id = $1`,
          [req.params.id],
        ),
      );
      const row = r.rows[0];
      if (!row) throw notFound('Document');
      await audit(req, 'document.download', req.params.id, meta.ownerUserId, meta.householdId);
      // Zawsze jako załącznik i z CSP „sandbox” — plik nie jest renderowany w originie aplikacji.
      return reply
        .header('content-type', MIME[row.format] ?? 'application/octet-stream')
        .header('content-disposition', attachment(row.filename))
        .header('content-security-policy', "sandbox; default-src 'none'")
        .send(row.content);
    });

    for (const [path, visibility, action] of [
      ['share', 'shared', 'document.share'],
      ['unshare', 'private', 'document.unshare'],
    ] as const) {
      app.post<{ Params: { id: string } }>(`/documents/:id/${path}`, async (req) => {
        const auth = requireAuth(req);
        const meta = await authorize(deps.db, req, 'document', req.params.id, action);
        const doc = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
          setDocumentVisibility(c, req.params.id, auth.userId, visibility),
        );
        await audit(req, action, req.params.id, meta.ownerUserId, meta.householdId);
        return doc;
      });
    }

    app.post<{ Params: { id: string } }>('/documents/:id/reindex', async (req) => {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'document', req.params.id, 'document.reindex');
      const res = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
        reindexDocument(c, req.params.id, auth.userId, req.id),
      );
      await audit(req, 'document.reindex', req.params.id, meta.ownerUserId, meta.householdId);
      deps.kickQueue();
      return res;
    });

    app.delete<{ Params: { id: string } }>('/documents/:id', async (req) => {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'document', req.params.id, 'document.delete');
      await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const r = await c.query('DELETE FROM documents WHERE id = $1', [req.params.id]);
        if (r.rowCount !== 1) throw notFound('Document');
        await emitEvent(c, {
          householdId: meta.householdId,
          ownerUserId: auth.userId,
          visibility: meta.visibility,
          type: 'document.updated',
          payload: { documentId: req.params.id, status: 'deleted' },
        });
      });
      await audit(req, 'document.delete', req.params.id, meta.ownerUserId, meta.householdId);
      return { ok: true };
    });
  };
