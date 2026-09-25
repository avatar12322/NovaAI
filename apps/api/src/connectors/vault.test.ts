import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveKey, parseOldKeys, Vault, VaultError } from './vault';

const k = () => randomBytes(32).toString('base64');

describe('sejf tokenów', () => {
  it('szyfruje i odszyfrowuje; szyfrogram nie zawiera jawnego tekstu', () => {
    const v = new Vault({ id: 'k1', key: deriveKey(k()) });
    const { blob, keyId } = v.encrypt('ya29.SEKRETNY-TOKEN', 'user-a|google|conn-1');
    expect(blob.toString('latin1')).not.toContain('SEKRETNY');
    expect(v.decrypt(blob, keyId, 'user-a|google|conn-1')).toBe('ya29.SEKRETNY-TOKEN');
  });

  it('podmiana rekordu między użytkownikami (inne AAD) jest wykrywana', () => {
    const v = new Vault({ id: 'k1', key: deriveKey(k()) });
    const { blob, keyId } = v.encrypt('token-alfy', 'user-a|google|conn-1');
    expect(() => v.decrypt(blob, keyId, 'user-b|google|conn-1')).toThrow(VaultError);
  });

  it('modyfikacja szyfrogramu jest wykrywana', () => {
    const v = new Vault({ id: 'k1', key: deriveKey(k()) });
    const { blob, keyId } = v.encrypt('token', 'aad');
    blob[blob.length - 1]! ^= 0x01;
    expect(() => v.decrypt(blob, keyId, 'aad')).toThrow(VaultError);
  });

  it('rotacja: stary klucz odszyfrowuje, nowe szyfrowanie używa nowego klucza', () => {
    const oldSecret = k();
    const before = new Vault({ id: 'k1', key: deriveKey(oldSecret) });
    const enc = before.encrypt('token', 'aad');
    const after = new Vault({ id: 'k2', key: deriveKey(k()) }, parseOldKeys(`k1:${oldSecret}`));
    expect(after.needsRotation(enc.keyId)).toBe(true);
    expect(after.decrypt(enc.blob, enc.keyId, 'aad')).toBe('token');
    expect(after.encrypt('token', 'aad').keyId).toBe('k2');
    const withoutOld = new Vault({ id: 'k2', key: deriveKey(k()) });
    expect(() => withoutOld.decrypt(enc.blob, enc.keyId, 'aad')).toThrow(/Brak klucza/);
  });

  it('zbyt krótki klucz główny jest odrzucany', () => {
    expect(() => deriveKey(Buffer.alloc(16).toString('base64'))).toThrow(VaultError);
  });
});
