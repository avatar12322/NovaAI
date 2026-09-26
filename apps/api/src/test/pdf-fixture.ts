/**
 * Minimalny generator PDF do testów (bez zależności): każda strona to lista linii tekstu ASCII
 * w czcionce Helvetica. Pusta lista linii = strona bez warstwy tekstowej (jak skan).
 */
export function makePdf(pages: string[][]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects: string[] = [];
  const pageIds: number[] = [];
  // 1: katalog, 2: drzewo stron, 3: czcionka; dalej pary (strona, treść).
  pages.forEach((lines, i) => {
    const pageId = 4 + i * 2;
    pageIds.push(pageId);
    const text = lines.length
      ? `BT /F1 12 Tf 14 TL 72 760 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`
      : '';
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] =
      `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`;
  });
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++)
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
