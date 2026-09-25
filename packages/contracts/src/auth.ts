import { z } from 'zod';
import { Uuid } from './common';

export const DevUserKey = z.enum(['alfa', 'beta']);
export type DevUserKey = z.infer<typeof DevUserKey>;

export const DevLoginRequest = z.object({ user: DevUserKey });
export type DevLoginRequest = z.infer<typeof DevLoginRequest>;

export const DevUser = z.object({ key: DevUserKey, displayName: z.string(), email: z.string() });
export type DevUser = z.infer<typeof DevUser>;

export const AgentSummary = z.object({
  id: Uuid,
  kind: z.enum(['private', 'household']),
  name: z.string(),
});
export type AgentSummary = z.infer<typeof AgentSummary>;

export const MeResponse = z.object({
  user: z.object({ id: Uuid, email: z.string(), displayName: z.string() }),
  household: z
    .object({
      id: Uuid,
      name: z.string(),
      role: z.enum(['owner', 'member']),
      members: z.array(z.object({ id: Uuid, displayName: z.string() })),
    })
    .nullable(),
  agents: z.array(AgentSummary),
  session: z.object({ method: z.enum(['dev', 'passkey']), expiresAt: z.string() }),
  env: z.enum(['development', 'test', 'production']),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  env: z.string(),
  version: z.string(),
  db: z.enum(['ok', 'down']),
  migrations: z.object({ applied: z.number(), pending: z.number() }).optional(),
  queue: z.enum(['running', 'disabled']).optional(),
  model: z
    .object({ mode: z.enum(['configured', 'demo']), providers: z.array(z.string()) })
    .optional(),
  devLogin: z.boolean(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
