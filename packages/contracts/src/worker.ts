import { z } from 'zod';
import { Uuid } from './common';

/**
 * Protokół Worker ↔ DeviceBroker, wersja 1. Ten sam kontrakt implementuje Rust (workers/windows/src/protocol.rs).
 *
 * - Połączenie zawsze WYCHODZĄCE z Workera (WebSocket, TLS poza localhost).
 * - Ramki `command` i `grants` są podpisane kluczem serwera (Ed25519), przypiętym przy parowaniu.
 * - Ramki `result` są podpisane kluczem urządzenia (Ed25519), wygenerowanym na urządzeniu.
 * - Podpis obejmuje DOKŁADNE bajty pola `payload` (string JSON) — bez kanonikalizacji.
 */
export const WORKER_PROTOCOL_VERSION = 1;

export const DeviceCapability = z.enum([
  'device.files.list',
  'device.files.read',
  'device.files.write',
  'device.git.status',
  'device.git.diff',
]);
export type DeviceCapability = z.infer<typeof DeviceCapability>;

/** Uprawnienie (grant) wymagane przez zdolność. */
export const GRANT_FOR: Record<
  DeviceCapability,
  'device.files.read' | 'device.files.write' | 'device.git.read'
> = {
  'device.files.list': 'device.files.read',
  'device.files.read': 'device.files.read',
  'device.files.write': 'device.files.write',
  'device.git.status': 'device.git.read',
  'device.git.diff': 'device.git.read',
};

export const GrantCapability = z.enum([
  'device.files.read',
  'device.files.write',
  'device.git.read',
]);
export type GrantCapability = z.infer<typeof GrantCapability>;

const Path = z.string().min(1).max(1024);

export const CommandParams = {
  'device.files.list': z.object({ path: Path }),
  'device.files.read': z.object({ path: Path }),
  'device.files.write': z.object({
    path: Path,
    content: z.string().max(512 * 1024),
    /** SHA-256 treści, na której oparto podgląd; null = nowy plik. Inna zawartość => odmowa. */
    baseSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  }),
  'device.git.status': z.object({ repoPath: Path }),
  'device.git.diff': z.object({ repoPath: Path }),
} as const;

export const CommandPayload = z.object({
  v: z.literal(WORKER_PROTOCOL_VERSION),
  commandId: Uuid,
  deviceId: Uuid,
  taskId: Uuid.nullable(),
  capability: DeviceCapability,
  params: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(8).max(200),
  issuedAt: z.string(),
  deadline: z.string(),
});
export type CommandPayload = z.infer<typeof CommandPayload>;

export const GrantsPayload = z.object({
  v: z.literal(WORKER_PROTOCOL_VERSION),
  deviceId: Uuid,
  issuedAt: z.string(),
  grants: z.array(z.object({ capability: GrantCapability, root: Path })),
});
export type GrantsPayload = z.infer<typeof GrantsPayload>;

export const ResultPayload = z.object({
  v: z.literal(WORKER_PROTOCOL_VERSION),
  commandId: Uuid,
  idempotencyKey: z.string(),
  status: z.enum(['ok', 'error', 'denied']),
  output: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().max(2000).nullable(),
  completedAt: z.string(),
});
export type ResultPayload = z.infer<typeof ResultPayload>;

/** Ramki od serwera do Workera. */
export const ServerFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('challenge'), nonce: z.string(), protocolVersion: z.number() }),
  z.object({ type: z.literal('welcome'), deviceId: Uuid }),
  z.object({ type: z.literal('command'), payload: z.string(), sig: z.string() }),
  z.object({ type: z.literal('grants'), payload: z.string(), sig: z.string() }),
  z.object({ type: z.literal('ack'), commandId: Uuid }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** Ramki od Workera do serwera. */
export const WorkerFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    deviceId: Uuid,
    nonce: z.string(),
    /** Ed25519(deviceKey, "nova-worker-hello-v1|<deviceId>|<nonce>") */
    sig: z.string(),
    workerVersion: z.string().max(40),
    platform: z.string().max(40),
  }),
  z.object({
    type: z.literal('result'),
    payload: z.string().max(2 * 1024 * 1024),
    sig: z.string(),
  }),
]);
export type WorkerFrame = z.infer<typeof WorkerFrame>;

export const helloMessage = (deviceId: string, nonce: string) =>
  `nova-worker-hello-v1|${deviceId}|${nonce}`;

export const PairRequest = z.object({
  code: z.string().min(6).max(20),
  name: z.string().trim().min(1).max(80),
  platform: z.string().max(40),
  /** Klucz publiczny Ed25519 urządzenia, 32 bajty, base64. */
  publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  protocolVersion: z.number().int(),
});
export type PairRequest = z.infer<typeof PairRequest>;

export const PairResponse = z.object({
  deviceId: Uuid,
  /** Klucz publiczny Ed25519 serwera do weryfikacji poleceń (base64, 32 bajty). */
  serverPublicKey: z.string(),
  protocolVersion: z.number(),
});
export type PairResponse = z.infer<typeof PairResponse>;

/** API urządzeń dla UI. */
export const Device = z.object({
  id: Uuid,
  name: z.string(),
  platform: z.string(),
  status: z.enum(['active', 'revoked']),
  online: z.boolean(),
  pairedAt: z.string(),
  lastSeenAt: z.string().nullable(),
  grants: z.array(
    z.object({ id: Uuid, capability: GrantCapability, root: z.string(), createdAt: z.string() }),
  ),
});
export type Device = z.infer<typeof Device>;

export const CreateGrantRequest = z.object({ capability: GrantCapability, root: Path });
export type CreateGrantRequest = z.infer<typeof CreateGrantRequest>;
