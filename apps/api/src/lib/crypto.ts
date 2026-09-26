import { createHash, randomBytes } from 'node:crypto';

export function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Kanoniczny JSON (posortowane klucze, bez spacji). Używany do skrótów zamrożonych akcji
 * i parametrów w audycie — ta sama akcja zawsze daje ten sam skrót.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number');
    if (value === undefined) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function hashParams(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
