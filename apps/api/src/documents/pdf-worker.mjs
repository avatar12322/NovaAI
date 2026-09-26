// Wyodrębnianie tekstu PDF w osobnym wątku (worker_threads): wątek główny może go zakończyć po
// przekroczeniu czasu lub pamięci, więc złośliwy albo uszkodzony plik nie blokuje API.
// Czysty JavaScript (bez TypeScript), bo ten sam plik działa w dev (tsx), testach i w bundlu (dist/).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const { data, maxPages, maxChars } = workerData;

async function run() {
  const task = pdfjs.getDocument({
    data,
    // Bez wykonywania kodu z pliku i bez ładowania czcionek do środowiska — potrzebny jest tylko tekst.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    verbosity: 0,
    standardFontDataUrl: join(pdfRoot, 'standard_fonts') + '/',
    cMapUrl: join(pdfRoot, 'cmaps') + '/',
    cMapPacked: true,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    const name = err && err.name;
    if (name === 'PasswordException') return { error: 'encrypted' };
    return { error: 'invalid_pdf', detail: String(name) + ': ' + String(err && err.message) };
  }
  if (doc.numPages > maxPages) return { error: 'too_many_pages', pages: doc.numPages };
  const pages = [];
  let total = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      text += item.str;
      if (item.hasEOL) text += '\n';
      else if (item.str && !item.str.endsWith(' ')) text += ' ';
    }
    text = text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    total += text.length;
    if (total > maxChars) return { error: 'too_much_text' };
    pages.push({ page: i, text });
    page.cleanup();
  }
  await task.destroy();
  return { pages, pageCount: pages.length };
}

run().then(
  (result) => parentPort.postMessage(result),
  (err) => parentPort.postMessage({ error: 'invalid_pdf', detail: String(err && err.stack) }),
);
