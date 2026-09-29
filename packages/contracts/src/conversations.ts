import { z } from 'zod';
import { LIMITS, Space, Uuid, Visibility, pageOf } from './common';

export const Conversation = z.object({
  id: Uuid,
  space: Space,
  visibility: Visibility,
  title: z.string(),
  ownerUserId: Uuid,
  agent: z.object({ id: Uuid, kind: z.enum(['private', 'household']), name: z.string() }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof Conversation>;
export const ConversationPage = pageOf(Conversation);
export type ConversationPage = z.infer<typeof ConversationPage>;

export const CreateConversationRequest = z.object({
  space: Space,
  title: z.string().trim().min(1).max(LIMITS.titleChars).optional(),
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequest>;

export const ListConversationsQuery = z.object({
  space: Space.default('private'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});

export const MessageRole = z.enum(['user', 'assistant', 'tool', 'system']);
export const Message = z.object({
  id: Uuid,
  conversationId: Uuid,
  role: MessageRole,
  authorUserId: Uuid.nullable(),
  authorName: z.string().nullable(),
  content: z.string(),
  meta: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type Message = z.infer<typeof Message>;
export const MessagePage = pageOf(Message);
export type MessagePage = z.infer<typeof MessagePage>;

export const PostMessageRequest = z.object({
  content: z.string().trim().min(1).max(LIMITS.messageChars),
  /** Zdjęcia wgrane wcześniej (POST /api/chat-images), najwyżej 4 na wiadomość. */
  images: z.array(Uuid).max(4).optional(),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

export const PostMessageResponse = z.object({
  message: Message,
  taskId: Uuid.nullable(),
});
export type PostMessageResponse = z.infer<typeof PostMessageResponse>;
