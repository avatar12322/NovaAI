import type { Task, TaskStep } from '@nova/contracts';

/** Etap pracy nazwany po ludzku — z narzędzia wykonywanego w tej chwili. */
const TOOL_STAGE: Array<[prefix: string, label: string]> = [
  ['documents.read', 'Czyta dokument'],
  ['documents.search', 'Przeszukuje dokumenty'],
  ['mail.search', 'Przeszukuje pocztę'],
  ['mail.read', 'Czyta e-mail'],
  ['mail.', 'Przygotowuje e-mail'],
  ['calendar.', 'Sprawdza kalendarz'],
  ['slack.', 'Przegląda Slacka'],
  ['memory.', 'Zapisuje w pamięci'],
  ['reminder.', 'Ustawia przypomnienie'],
  ['household.', 'Przygotowuje wiadomość'],
  ['device.', 'Pracuje na urządzeniu'],
];

export function stageOf(task: Task | null): { label: string; detail: string | null } {
  const steps: TaskStep[] = task?.steps ?? [];
  const running = steps.find((s) => s.status === 'running');
  if (!task || task.status === 'queued') return { label: 'Zaczyna', detail: null };
  if (!running) {
    // Między krokami: wykonane narzędzia, a odpowiedź jeszcze nie ruszyła.
    const pendingFollowup = steps.some((s) => s.key === 'followup' && s.status === 'pending');
    return pendingFollowup
      ? { label: 'Układa odpowiedź', detail: null }
      : { label: 'Myśli', detail: null };
  }
  if (running.key === 'followup') return { label: 'Układa odpowiedź', detail: null };
  if (running.kind === 'tool' && running.tool) {
    const hit = TOOL_STAGE.find(([p]) => running.tool!.startsWith(p));
    return { label: hit?.[1] ?? 'Wykonuje akcję', detail: running.title };
  }
  return { label: 'Myśli', detail: null };
}
