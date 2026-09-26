import { DOCUMENT_LIMITS, type DocumentFormat } from '@nova/contracts';
import { Worker } from 'node:worker_threads';
import { chunkPages, chunkText, type ChunkDraft } from './chunk';
import { decodeText, DocumentError } from './text';

const PDF_TIMEOUT_MS = 30_000;

interface Extracted {
  chunks: ChunkDraft[];
  pageCount: number | null;
  charCount: number;
  encoding?: string;
}

type WorkerResult =
  | { pages: Array<{ page: number; text: string }>; pageCount: number }
  | { error: 'encrypted' | 'invalid_pdf' | 'too_many_pages' | 'too_much_text'; pages?: number };

/** Tekst z PDF w osobnym wątku z limitem czasu i pamięci (wątek jest kończony przy przekroczeniu). */
export function extractPdfPages(
  bytes: Buffer,
  opts: { timeoutMs?: number; maxPages?: number; maxChars?: number } = {},
): Promise<{ pages: Array<{ page: number; text: string }>; pageCount: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-worker.mjs', import.meta.url), {
      workerData: {
        data: new Uint8Array(bytes),
        maxPages: opts.maxPages ?? DOCUMENT_LIMITS.maxPages,
        maxChars: opts.maxChars ?? DOCUMENT_LIMITS.maxChars,
      },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new DocumentError(
              'timeout',
              'Odczyt pliku PDF trwał zbyt długo — plik może być uszkodzony',
            ),
          ),
        ),
      opts.timeoutMs ?? PDF_TIMEOUT_MS,
    );
    worker.once('message', (r: WorkerResult) =>
      finish(() => {
        if ('error' in r) {
          const messages: Record<string, string> = {
            encrypted: 'Plik PDF jest zabezpieczony hasłem — usuń zabezpieczenie i dodaj ponownie',
            invalid_pdf: 'Nie udało się odczytać pliku PDF — plik jest uszkodzony lub nietypowy',
            too_many_pages: `PDF ma ${r.pages ?? 'zbyt wiele'} stron — limit to ${opts.maxPages ?? DOCUMENT_LIMITS.maxPages}`,
            too_much_text: 'Dokument zawiera zbyt dużo tekstu do zindeksowania',
          };
          reject(new DocumentError(r.error, messages[r.error]!));
        } else resolve(r);
      }),
    );
    worker.once('error', () =>
      finish(() =>
        reject(
          new DocumentError(
            'too_complex',
            'Plik PDF jest zbyt złożony do odczytania (limit pamięci)',
          ),
        ),
      ),
    );
    worker.once('exit', (code) =>
      finish(() =>
        reject(new DocumentError('invalid_pdf', `Nie udało się odczytać pliku PDF (kod ${code})`)),
      ),
    );
  });
}

/** Tekst i fragmenty dokumentu. Błędy treści => DocumentError z komunikatem dla użytkownika. */
export async function extractDocument(format: DocumentFormat, bytes: Buffer): Promise<Extracted> {
  if (format === 'pdf') {
    const { pages, pageCount } = await extractPdfPages(bytes);
    const charCount = pages.reduce((n, p) => n + p.text.length, 0);
    if (charCount === 0) {
      throw new DocumentError(
        'no_text',
        'PDF nie zawiera warstwy tekstowej (np. skan) — rozpoznawanie tekstu (OCR) nie jest obsługiwane',
      );
    }
    return { chunks: chunkPages(pages), pageCount, charCount };
  }
  const { text, encoding } = decodeText(bytes);
  if (text.length > DOCUMENT_LIMITS.maxChars) {
    throw new DocumentError('too_much_text', 'Dokument zawiera zbyt dużo tekstu do zindeksowania');
  }
  return { chunks: chunkText(text, format), pageCount: null, charCount: text.length, encoding };
}
