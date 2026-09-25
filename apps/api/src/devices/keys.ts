import {
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import type { AppConfig } from '../config';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function privateKeyFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== 32) throw new Error('seed Ed25519 musi mieć 32 bajty');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('klucz publiczny Ed25519 musi mieć 32 bajty');
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export function rawPublicKey(key: KeyObject): Buffer {
  const pub = key.type === 'public' ? key : createPublicKey(key);
  const der = pub.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
}

export function signText(key: KeyObject, text: string): string {
  return sign(null, Buffer.from(text, 'utf8'), key).toString('base64');
}

export function verifyText(pub: KeyObject, text: string, sigB64: string): boolean {
  try {
    const sig = Buffer.from(sigB64, 'base64');
    if (sig.length !== 64) return false;
    return verify(null, Buffer.from(text, 'utf8'), pub, sig);
  } catch {
    return false;
  }
}

/**
 * Klucz podpisujący polecenia dla urządzeń. Pochodna NOVA_SECRET_KEY (HKDF), więc stała między restartami —
 * Workery przypinają klucz publiczny przy parowaniu. Bez sekretu (tylko dev/test) — jawnie niebezpieczny klucz dev.
 */
export function deviceSigningKey(config: AppConfig): {
  key: KeyObject;
  publicRaw: Buffer;
  insecureDev: boolean;
} {
  let ikm: Buffer;
  let insecureDev = false;
  if (config.secretKey) ikm = Buffer.from(config.secretKey, 'base64');
  else if (config.env !== 'production') {
    ikm = Buffer.from('nova-insecure-dev-key-do-not-use-in-production');
    insecureDev = true;
  } else throw new Error('NOVA_SECRET_KEY jest wymagany do podpisywania poleceń urządzeń');
  const seed = Buffer.from(hkdfSync('sha256', ikm, 'nova', 'device-signing-v1', 32));
  const key = privateKeyFromSeed(seed);
  return { key, publicRaw: rawPublicKey(key), insecureDev };
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Kod parowania: 8 znaków (40 bitów), bez mylących znaków, format XXXX-XXXX. */
export function pairingCode(): string {
  const bytes = randomBytes(8);
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % 32];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
