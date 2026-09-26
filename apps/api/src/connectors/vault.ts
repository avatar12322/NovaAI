import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Szyfrowanie sekretów w spoczynku (tokeny OAuth): AES-256-GCM, klucz pochodny HKDF z klucza głównego.
 * AAD wiąże szyfrogram z (użytkownik, dostawca, id połączenia) — podmiana rekordów między użytkownikami
 * kończy się błędem uwierzytelnienia. Rotacja: nowy klucz główny + stare klucze tylko do odszyfrowania.
 */
interface VaultKey {
  id: string;
  key: Buffer;
}

export class VaultError extends Error {}

const VERSION = 1;

export function deriveKey(masterB64: string): Buffer {
  const master = Buffer.from(masterB64, 'base64');
  if (master.length < 32)
    throw new VaultError('Klucz główny musi mieć co najmniej 32 bajty (base64)');
  return Buffer.from(hkdfSync('sha256', master, 'nova', 'token-encryption-v1', 32));
}

/** `NOVA_SECRET_KEYS_OLD` w formacie `id:base64,id2:base64`. */
export function parseOldKeys(raw: string | undefined): VaultKey[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(':');
      if (i <= 0) throw new VaultError('Nieprawidłowy format NOVA_SECRET_KEYS_OLD');
      return { id: pair.slice(0, i), key: deriveKey(pair.slice(i + 1)) };
    });
}

export class Vault {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly primary: VaultKey,
    old: VaultKey[] = [],
  ) {
    this.keys.set(primary.id, primary.key);
    for (const k of old) if (!this.keys.has(k.id)) this.keys.set(k.id, k.key);
  }

  get primaryId(): string {
    return this.primary.id;
  }

  encrypt(plaintext: string, aad: string): { keyId: string; blob: Buffer } {
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.primary.key, nonce);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    // [wersja(1) | nonce(12) | tag(16) | szyfrogram]
    return {
      keyId: this.primary.id,
      blob: Buffer.concat([Buffer.from([VERSION]), nonce, tag, ct]),
    };
  }

  decrypt(blob: Buffer, keyId: string, aad: string): string {
    const key = this.keys.get(keyId);
    if (!key) throw new VaultError(`Brak klucza ${keyId} (rotacja?)`);
    if (blob.length < 29 || blob[0] !== VERSION)
      throw new VaultError('Nieznany format szyfrogramu');
    const nonce = blob.subarray(1, 13);
    const tag = blob.subarray(13, 29);
    const ct = blob.subarray(29);
    try {
      const d = createDecipheriv('aes-256-gcm', key, nonce);
      d.setAAD(Buffer.from(aad, 'utf8'));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch {
      throw new VaultError('Uwierzytelnienie szyfrogramu nie powiodło się');
    }
  }

  /** Czy szyfrogram wymaga ponownego zaszyfrowania bieżącym kluczem. */
  needsRotation(keyId: string): boolean {
    return keyId !== this.primary.id;
  }
}

export function vaultFromEnv(
  secretKey: string,
  secretKeyId: string,
  oldKeys: string | undefined,
): Vault | null {
  if (!secretKey) return null;
  return new Vault({ id: secretKeyId, key: deriveKey(secretKey) }, parseOldKeys(oldKeys));
}
