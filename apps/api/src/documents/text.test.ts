import { describe, expect, it } from 'vitest';
import { makePdf } from '../test/pdf-fixture';
import { chunkPages, chunkText, CHUNK_MAX } from './chunk';
import { extractDocument, extractPdfPages } from './extract';
import {
  decodeText,
  detectFormat,
  DocumentError,
  normalize,
  queryTerms,
  snippet,
  toTsQuery,
} from './text';

describe('tekst i format', () => {
  it('normalizacja bez znaków diakrytycznych', () => {
    expect(normalize('Zażółć GĘŚLĄ jaźń')).toBe('zazolc gesla jazn');
  });
  it('format z rozszerzenia potwierdzony treścią', () => {
    expect(detectFormat('a.PDF', Buffer.from('%PDF-1.4\n'))).toBe('pdf');
    expect(detectFormat('notatki.markdown', Buffer.from('# x'))).toBe('md');
    expect(() => detectFormat('a.pdf', Buffer.from('to nie pdf'))).toThrow(DocumentError);
    expect(() => detectFormat('a.docx', Buffer.from('x'))).toThrow(/Nieobsługiwany format/);
    expect(() => detectFormat('a.txt', Buffer.from('%PDF-1.7'))).toThrow(/PDF/);
  });
  it('UTF-8 z BOM, Windows-1250 jako zapas, binarny odrzucony, pusty odrzucony', () => {
    expect(decodeText(Buffer.from('﻿Żółw\r\nlinia', 'utf8'))).toEqual({
      text: 'Żółw\nlinia',
      encoding: 'utf-8',
    });
    // „Łódź” w Windows-1250: A3 F3 64 9F
    expect(decodeText(Buffer.from([0xa3, 0xf3, 0x64, 0x9f]))).toEqual({
      text: 'Łódź',
      encoding: 'windows-1250',
    });
    expect(() => decodeText(Buffer.from([0x41, 0x00, 0x42]))).toThrow(/binarny/);
    expect(() => decodeText(Buffer.from('  \n\n '))).toThrow(/nie zawiera tekstu/);
  });
  it('termy zapytania: polska odmiana przez prefiks, słowa funkcyjne pominięte, liczby dokładnie', () => {
    expect(queryTerms('Ile wynosi kaucja za mieszkanie w 2024?')).toEqual([
      { stem: 'wynos', prefix: true },
      { stem: 'kaucj', prefix: true },
      { stem: 'mieszkan', prefix: true },
      { stem: '2024', prefix: false },
    ]);
    expect(toTsQuery(queryTerms('umowy najmu'))).toBe('umow:* | najm:*');
    expect(queryTerms("'); DROP TABLE x; --")).toEqual([
      { stem: 'dro', prefix: true },
      { stem: 'tabl', prefix: true },
    ]);
  });
  it('wycinek z zaznaczonymi trafieniami (odmiana i znaki diakrytyczne)', () => {
    const segs = snippet('Najemca wpłaca kaucję w wysokości 3000 zł.', queryTerms('kaucja'));
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['kaucję']);
    expect(segs.map((s) => s.text).join('')).toBe('Najemca wpłaca kaucję w wysokości 3000 zł.');
  });
});

describe('fragmenty', () => {
  it('Markdown: ścieżka nagłówków, zakres linii, nagłówki w blokach kodu ignorowane', () => {
    const md = [
      '# Umowa najmu',
      '',
      'Strony umowy.',
      '',
      '## Kaucja',
      '',
      'Kaucja wynosi 3000 zł.',
      '```',
      '# to nie nagłówek',
      '```',
      '',
      '## Wypowiedzenie',
      'Okres wypowiedzenia: 3 miesiące.',
    ].join('\n');
    const chunks = chunkText(md, 'md');
    const kaucja = chunks.find((c) => c.content.includes('3000'))!;
    expect(kaucja.heading).toBe('Umowa najmu › Kaucja');
    expect(kaucja.lineStart).toBe(5);
    expect(kaucja.content).toContain('# to nie nagłówek');
    const wyp = chunks.find((c) => c.content.includes('3 miesiące'))!;
    expect(wyp.heading).toBe('Umowa najmu › Wypowiedzenie');
    expect([wyp.lineStart, wyp.lineEnd]).toEqual([12, 13]);
  });
  it('Markdown: same nagłówki łączą się z następną treścią (bez fragmentów z samym tytułem)', () => {
    const chunks = chunkText('# Piec\n\n## Serwis\n\nPrzegląd we wrześniu.\n', 'md');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ heading: 'Piec › Serwis', lineStart: 1, lineEnd: 5 });
  });
  it('wycinek bez znaczników nagłówków Markdown', () => {
    const text = snippet('## Ciśnienie\n\nCiśnienie 1,5 bar.', queryTerms('ciśnienie'))
      .map((s) => s.text)
      .join('');
    expect(text).toBe('Ciśnienie Ciśnienie 1,5 bar.');
  });
  it('długi tekst: fragmenty ≤ limit, ciągłe numery linii, bez utraty treści', () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `Linia numer ${i + 1} z przykładowym tekstem.`,
    );
    const chunks = chunkText(lines.join('\n'), 'txt');
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(CHUNK_MAX);
    expect(chunks[0]!.lineStart).toBe(1);
    expect(chunks[chunks.length - 1]!.lineEnd).toBe(400);
    for (let i = 1; i < chunks.length; i++)
      expect(chunks[i]!.lineStart).toBe(chunks[i - 1]!.lineEnd! + 1);
    expect(chunks.map((c) => c.content).join('\n')).toBe(lines.join('\n'));
  });
  it('jedna bardzo długa linia jest dzielona', () => {
    const chunks = chunkText('słowo '.repeat(1000), 'txt');
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(CHUNK_MAX);
  });
  it('PDF: fragment nie przekracza granicy strony', () => {
    const chunks = chunkPages([
      { page: 1, text: 'Pierwsza strona.' },
      { page: 2, text: 'Druga strona.' },
    ]);
    expect(chunks.map((c) => [c.page, c.content])).toEqual([
      [1, 'Pierwsza strona.'],
      [2, 'Druga strona.'],
    ]);
  });
});

describe('odczyt PDF w osobnym wątku', () => {
  it('tekst ze stron z numerami', async () => {
    const pdf = makePdf([['Umowa najmu'], ['Kaucja wynosi 3000 zl.', 'Zwrot w 30 dni.']]);
    const r = await extractPdfPages(pdf);
    expect(r.pageCount).toBe(2);
    expect(r.pages[1]).toEqual({ page: 2, text: 'Kaucja wynosi 3000 zl.\nZwrot w 30 dni.' });
  });
  it('uszkodzony PDF, PDF bez tekstu (skan), limit stron, limit czasu', async () => {
    await expect(extractDocument('pdf', Buffer.from('%PDF-1.4\nśmieci'))).rejects.toMatchObject({
      code: 'invalid_pdf',
    });
    await expect(extractDocument('pdf', makePdf([[], []]))).rejects.toMatchObject({
      code: 'no_text',
    });
    await expect(
      extractPdfPages(makePdf([['a'], ['b'], ['c']]), { maxPages: 2 }),
    ).rejects.toMatchObject({ code: 'too_many_pages' });
    await expect(extractPdfPages(makePdf([['a']]), { timeoutMs: 1 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});
