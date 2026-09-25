import { z } from 'zod';
import { Uuid, pageOf } from './common';

export const ApprovalStatus = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'invalidated',
  'executing',
  'executed',
  'failed',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const Approval = z.object({
  id: Uuid,
  taskId: Uuid,
  stepId: Uuid,
  taskTitle: z.string(),
  tool: z.string(),
  capability: z.string(),
  /** Zamrożone parametry akcji — dokładnie to zostanie wykonane. */
  action: z.record(z.string(), z.unknown()),
  actionHash: z.string(),
  summary: z.string(),
  target: z.string(),
  scope: z.string(),
  diff: z.string().nullable(),
  status: ApprovalStatus,
  expiresAt: z.string(),
  resolvedAt: z.string().nullable(),
  executedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Approval = z.infer<typeof Approval>;
export const ApprovalPage = pageOf(Approval);
export type ApprovalPage = z.infer<typeof ApprovalPage>;

export const ListApprovalsQuery = z.object({
  status: z.enum(['pending', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});

/** Zatwierdzenie dotyczy konkretnej wersji akcji — klient odsyła skrót, który widział. */
export const ApproveRequest = z.object({ actionHash: z.string().regex(/^[0-9a-f]{64}$/) });
export type ApproveRequest = z.infer<typeof ApproveRequest>;

export const RejectRequest = z.object({ reason: z.string().trim().max(500).optional() });
export type RejectRequest = z.infer<typeof RejectRequest>;
