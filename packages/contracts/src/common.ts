import { z } from 'zod';
import { LIMITS } from './limits';

export const Uuid = z.uuid();
export const Visibility = z.enum(['private', 'shared']);
export type Visibility = z.infer<typeof Visibility>;

/** Przestrzeń widoczna w UI: prywatna użytkownika albo wspólna NovaAI. */
export const Space = z.enum(['private', 'shared']);
export type Space = z.infer<typeof Space>;

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

export const IsoDate = z.string();

export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** Limity wielkości wejścia (egzekwowane w API i sprawdzane w UI). */
export { LIMITS };
