const rtf = new Intl.RelativeTimeFormat('pl', { numeric: 'auto' });

export function timeAgo(iso: string, now = Date.now()): string {
  const diff = (Date.parse(iso) - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'przed chwilą';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}

export const TASK_STATUS_PL: Record<string, string> = {
  queued: 'w kolejce',
  running: 'w toku',
  waiting_approval: 'czeka na zgodę',
  completed: 'zakończone',
  failed: 'błąd',
  cancelled: 'anulowane',
};

export const STEP_STATUS_PL: Record<string, string> = {
  pending: 'oczekuje',
  running: 'w toku',
  waiting_approval: 'czeka na zgodę',
  completed: 'gotowe',
  failed: 'błąd',
  cancelled: 'anulowane',
  skipped: 'pominięte',
};

export const EVENT_PL: Record<string, string> = {
  'task.created': 'Nowe zadanie',
  'task.status': 'Status zadania',
  'task.progress': 'Postęp',
  'step.status': 'Krok',
  'approval.requested': 'Prośba o zgodę',
  'approval.resolved': 'Zgoda rozstrzygnięta',
  'message.created': 'Wiadomość',
  'memory.changed': 'Pamięć',
  'notification.created': 'Powiadomienie',
  'budget.warning': 'Budżet: ostrzeżenie',
  'budget.blocked': 'Budżet: blokada',
  'device.status': 'Urządzenie',
};

export function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}
