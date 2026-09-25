import type { z } from 'zod';
import { badRequest } from './errors';

/** Walidacja runtime payloadu. Błąd zawiera ścieżki pól, nie wartości (mogą być wrażliwe). */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    throw badRequest(
      'Nieprawidłowe dane wejściowe',
      r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
    );
  }
  return r.data;
}
