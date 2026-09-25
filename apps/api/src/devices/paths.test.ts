import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { isWithinRoot, normalizePath, PathRejected } from './paths';
import {
  normalizeCode,
  pairingCode,
  publicKeyFromRaw,
  rawPublicKey,
  signText,
  verifyText,
} from './keys';

describe('walidacja ścieżek (broker, leksykalnie)', () => {
  it('ścieżki w katalogu i poza nim (Windows, bez rozróżniania wielkości liter)', () => {
    expect(isWithinRoot('C:\\Projekty\\nova\\src\\a.ts', 'c:/projekty/nova')).toBe(true);
    expect(isWithinRoot('C:\\Projekty\\nova', 'C:\\Projekty\\nova\\')).toBe(true);
    expect(isWithinRoot('C:\\Projekty\\nova-evil\\x', 'C:\\Projekty\\nova')).toBe(false);
    expect(isWithinRoot('D:\\Projekty\\nova\\x', 'C:\\Projekty\\nova')).toBe(false);
  });
  it('path traversal i nietypowe formy są odrzucane', () => {
    expect(
      isWithinRoot('C:\\Projekty\\nova\\..\\..\\Windows\\system32', 'C:\\Projekty\\nova'),
    ).toBe(false);
    expect(() => normalizePath('C:\\a\\..\\b')).toThrow(PathRejected);
    expect(() => normalizePath('\\\\server\\share\\x')).toThrow(PathRejected);
    expect(() => normalizePath('C:\\a\\plik.txt:ukryty')).toThrow(/strumienie/);
    expect(() => normalizePath('C:\\a\\CON')).toThrow(/zarezerwowana/);
    expect(() => normalizePath('C:\\a\\nul.txt')).toThrow(/zarezerwowana/);
    expect(() => normalizePath('C:\\a\\trik. ')).toThrow();
    expect(() => normalizePath('relative\\path')).toThrow(/bezwzględna/);
    expect(() => normalizePath('/tmp/a\0b')).toThrow(/NUL/);
  });
  it('POSIX rozróżnia wielkość liter', () => {
    expect(isWithinRoot('/home/u/proj/x', '/home/u/proj')).toBe(true);
    expect(isWithinRoot('/home/u/Proj/x', '/home/u/proj')).toBe(false);
    expect(isWithinRoot('/home/u/proj/../../etc/passwd', '/home/u/proj')).toBe(false);
  });
});

describe('klucze i kody', () => {
  it('podpis Ed25519: poprawny weryfikuje się, zmieniona treść lub inny klucz — nie', () => {
    const a = generateKeyPairSync('ed25519');
    const b = generateKeyPairSync('ed25519');
    const pub = publicKeyFromRaw(rawPublicKey(a.publicKey));
    const sig = signText(a.privateKey, '{"x":1}');
    expect(verifyText(pub, '{"x":1}', sig)).toBe(true);
    expect(verifyText(pub, '{"x":2}', sig)).toBe(false);
    expect(verifyText(publicKeyFromRaw(rawPublicKey(b.publicKey)), '{"x":1}', sig)).toBe(false);
    expect(verifyText(pub, '{"x":1}', 'AAAA')).toBe(false);
  });
  it('kod parowania ma format XXXX-XXXX bez mylących znaków', () => {
    for (let i = 0; i < 50; i++) {
      const c = pairingCode();
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(normalizeCode(c.toLowerCase())).toBe(c.replace('-', ''));
    }
  });
});
