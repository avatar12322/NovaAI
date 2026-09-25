import { z } from 'zod';
import { LIMITS, Space, Uuid, Visibility, pageOf } from './common';

export const TaskStatus = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];

export const StepStatus = z.enum([
  'pending',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);
export type StepStatus = z.infer<typeof StepStatus>;

export const TaskStep = z.object({
  id: Uuid,
  seq: z.number(),
  key: z.string(),
  title: z.string(),
  kind: z.enum(['tool', 'model', 'note']),
  tool: z.string().nullable(),
  dependsOn: z.array(z.string()),
  requiresApproval: z.boolean(),
  status: StepStatus,
  approvalId: Uuid.nullable(),
  progress: z.number().nullable(),
  output: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type TaskStep = z.infer<typeof TaskStep>;

export const Task = z.object({
  id: Uuid,
  kind: z.string(),
  title: z.string(),
  status: TaskStatus,
  visibility: Visibility,
  ownerUserId: Uuid,
  isMine: z.boolean(),
  conversationId: Uuid.nullable(),
  progress: z.number().nullable(),
  attempts: z.number(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
  steps: z.array(TaskStep).optional(),
});
export type Task = z.infer<typeof Task>;
export const TaskPage = pageOf(Task);
export type TaskPage = z.infer<typeof TaskPage>;

export const ListTasksQuery = z.object({
  space: Space.default('private'),
  status: z.enum(['active', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});

/** Zadania, które użytkownik może utworzyć bezpośrednio (tury czatu tworzy serwer). */
export const CreateTaskRequest = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('demo.workflow'),
    space: Space.default('private'),
    title: z.string().trim().min(1).max(LIMITS.titleChars).optional(),
    /** Treść wiadomości do drugiej osoby, która będzie wymagała zgody. */
    message: z.string().trim().min(1).max(1000),
  }),
]);
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;
