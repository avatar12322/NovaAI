import { inflateRawSync } from 'node:zlib';

/**
 * Minimalny czytnik ZIP (tylko wskazane pliki; metody 0 — bez kompresji i 8 — deflate). Rozkłady GTFS
 * przychodzą jako ZIP, a Node ma w bibliotece standardowej tylko deflate — bez dodatkowej zależności.
 */
export function readZip(buf: Buffer, wanted: readonly string[]): Map<string, Buffer> {
  // Koniec katalogu centralnego (EOCD): sygnatura 0x06054b50 w ostatnich ≤ 65 557 bajtach.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: brak katalogu centralnego');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const want = new Set(wanted);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: uszkodzony katalog');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!want.has(name)) continue;
    // Dane za nagłówkiem lokalnym (jego pola nazwy i „extra” mogą się różnić od katalogu).
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
    else throw new Error(`zip: nieobsługiwana kompresja ${method}`);
  }
  return out;
}
