import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * Programowy uwierzytelniacz WebAuthn (tylko testy): attestation „none”, klucz ES256,
 * kontrola flag UP/UV, licznika i origin — do testów negatywnych po stronie serwera.
 */
function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([cborHead(3, b.length), b]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  const parts: Buffer[] = [cborHead(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return Buffer.concat(parts);
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();

export interface SoftOptions {
  origin?: string;
  rpId?: string;
  userVerified?: boolean;
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly key: { privateKey: KeyObject; publicKey: KeyObject } = generateKeyPairSync(
    'ec',
    { namedCurve: 'P-256' },
  );
  counter = 0;
  userHandle: string | null = null;

  constructor(private readonly defaults: { origin: string; rpId: string }) {}

  private cosePublicKey(): Buffer {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    );
  }

  private authData(rpId: string, uv: boolean, attested: boolean): Buffer {
    const flags = 0x01 | (uv ? 0x04 : 0) | (attested ? 0x40 : 0);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const parts: Buffer[] = [sha(rpId), Buffer.from([flags]), counter];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.cosePublicKey());
    }
    return Buffer.concat(parts);
  }

  /** Odpowiedź na `navigator.credentials.create()` dla opcji z serwera. */
  create(options: { challenge: string; user: { id: string } }, o: SoftOptions = {}) {
    this.userHandle = options.user.id;
    const clientData = JSON.stringify({
      type: 'webauthn.create',
      challenge: options.challenge,
      origin: o.origin ?? this.defaults.origin,
      crossOrigin: false,
    });
    const att = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', this.authData(o.rpId ?? this.defaults.rpId, o.userVerified ?? true, true)],
      ]),
    );
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientData),
        attestationObject: b64u(att),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** Odpowiedź na `navigator.credentials.get()`; licznik rośnie (można go cofnąć w teście). */
  get(options: { challenge: string }, o: SoftOptions & { counter?: number } = {}) {
    this.counter = o.counter ?? this.counter + 1;
    const clientData = JSON.stringify({
      type: 'webauthn.get',
      challenge: options.challenge,
      origin: o.origin ?? this.defaults.origin,
      crossOrigin: false,
    });
    const authData = this.authData(o.rpId ?? this.defaults.rpId, o.userVerified ?? true, false);
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha(clientData)]),
      this.key.privateKey,
    );
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: this.userHandle ?? undefined,
      },
      clientExtensionResults: {},
    };
  }
}
