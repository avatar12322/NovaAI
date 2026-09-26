import { z } from 'zod';
import { Space, Uuid, Visibility, pageOf } from './common';

export const DocumentFormat = z.enum(['pdf', 'txt', 'md']);
export type DocumentFormat = z.infer<typeof DocumentFormat>;
export const DocumentStatus = z.enum(['pending', 'indexing', 'ready', 'failed']);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const DocumentInfo = z.object({
  id: Uuid,
  title: z.string(),
  filename: z.string(),
  format: DocumentFormat,
  visibility: Visibility,
  sizeBytes: z.number(),
  status: DocumentStatus,
  error: z.string().nullable(),
  pageCount: z.number().nullable(),
  chunkCount: z.number(),
  ownerUserId: Uuid,
  ownerName: z.string().nullable(),
  isMine: z.boolean(),
  createdAt: z.string(),
  indexedAt: z.string().nullable(),
});
export type DocumentInfo = z.infer<typeof DocumentInfo>;
export const DocumentPage = pageOf(DocumentInfo);
export type DocumentPage = z.infer<typeof DocumentPage>;

export const ListDocumentsQuery = z.object({
  space: Space.default('private'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

export const UploadDocumentQuery = z.object({
  name: z.string().trim().min(1).max(255),
  space: Space.default('private'),
});

/** Miejsce w dokumencie: strona (PDF) albo linie i nagłówek (TXT/Markdown). */
export const DocumentLocator = z.object({
  page: z.number().nullable(),
  lineStart: z.number().nullable(),
  lineEnd: z.number().nullable(),
  heading: z.string().nullable(),
});
export type DocumentLocator = z.infer<typeof DocumentLocator>;

/** Fragment tekstu z zaznaczeniem trafień (bez HTML — UI renderuje segmenty). */
export const SnippetSegment = z.object({ text: z.string(), hit: z.boolean() });
export type SnippetSegment = z.infer<typeof SnippetSegment>;

export const DocumentSearchHit = DocumentLocator.extend({
  documentId: Uuid,
  title: z.string(),
  filename: z.string(),
  format: DocumentFormat,
  visibility: Visibility,
  ord: z.number(),
  snippet: z.array(SnippetSegment),
  matchedTerms: z.number(),
});
export type DocumentSearchHit = z.infer<typeof DocumentSearchHit>;

export const SearchDocumentsQuery = z.object({
  q: z.string().trim().min(1).max(300),
  limit: z.coerce.number().int().min(1).max(30).default(10),
});

export const DocumentChunk = DocumentLocator.extend({
  documentId: Uuid,
  ord: z.number(),
  content: z.string(),
  chunkCount: z.number(),
});
export type DocumentChunk = z.infer<typeof DocumentChunk>;

/** Źródło przekazane modelowi w turze rozmowy (zapisywane w meta odpowiedzi — bez treści). */
export const MessageSource = DocumentLocator.extend({
  ref: z.string(),
  documentId: Uuid,
  title: z.string(),
  ord: z.number(),
  cited: z.boolean(),
});
export type MessageSource = z.infer<typeof MessageSource>;
