import { z } from 'zod';
import { LIMITS, Space, Uuid, Visibility, pageOf } from './common';

export const MemoryKind = z.enum(['profile', 'episodic', 'knowledge']);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const Memory = z.object({
  id: Uuid,
  kind: MemoryKind,
  visibility: Visibility,
  content: z.string(),
  ownerUserId: Uuid,
  ownerName: z.string().nullable(),
  isMine: z.boolean(),
  source: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Memory = z.infer<typeof Memory>;
export const MemoryPage = pageOf(Memory);
export type MemoryPage = z.infer<typeof MemoryPage>;

export const ListMemoriesQuery = z.object({
  space: Space.default('private'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

export const CreateMemoryRequest = z.object({
  kind: MemoryKind.default('profile'),
  /** 'shared' = jawne udostępnienie w chwili utworzenia (audytowane jak memory.share). */
  space: Space.default('private'),
  content: z.string().trim().min(1).max(LIMITS.memoryChars),
});
export type CreateMemoryRequest = z.infer<typeof CreateMemoryRequest>;

export const UpdateMemoryRequest = z.object({
  content: z.string().trim().min(1).max(LIMITS.memoryChars),
});
export type UpdateMemoryRequest = z.infer<typeof UpdateMemoryRequest>;
