/**
 * Typy zdarzeń strumienia (SSE). Moduł bez zależności: przeglądarka subskrybuje dokładnie tę listę,
 * więc nowy typ zdarzenia nie może zostać pominięty po stronie klienta.
 */
export const EVENT_TYPES = [
  'task.created',
  'task.status',
  'task.progress',
  'step.status',
  'approval.requested',
  'approval.resolved',
  'message.created',
  'memory.changed',
  'notification.created',
  'notification.read',
  'budget.warning',
  'budget.blocked',
  'budget.changed',
  'device.status',
  'document.updated',
  'shopping.changed',
  'pantry.changed',
] as const;
