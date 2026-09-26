import { z } from 'zod';
import { EVENT_TYPES } from './event-types';
import { Uuid, Visibility } from './common';

/**
 * Zdarzenia Activity Strip. Payload zawiera identyfikatory, statusy i tytuły — nigdy sekrety
 * ani treść wiadomości/pamięci. Widoczność zdarzenia = widoczność zasobu źródłowego.
 */
export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

export const NovaEvent = z.object({
  id: z.number(),
  type: EventType,
  visibility: Visibility,
  taskId: Uuid.nullable(),
  ownerUserId: Uuid.nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type NovaEvent = z.infer<typeof NovaEvent>;

export const ListEventsQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  taskId: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const Notification = z.object({
  id: Uuid,
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export type Notification = z.infer<typeof Notification>;

/**
 * Fragment odpowiedzi modelu w trakcie pisania — ulotne zdarzenie SSE `message.delta` (bez id, bez zapisu
 * w bazie; pełna odpowiedź przychodzi potem jako `message.created`).
 */
export interface MessageDelta {
  conversationId: string;
  taskId: string;
  /** Krok tury: 'reply' albo 'followup'. */
  step: string;
  /** Kolejna próba (inny model po błędzie) zaczyna tekst od nowa. */
  attempt: number;
  /** Długość tekstu przed tym fragmentem — klient dokleja tylko fragmenty ciągłe. */
  offset: number;
  delta: string;
}
