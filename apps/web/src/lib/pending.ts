/**
 * Tura agenta rozpoczęta poza widokiem rozmowy (np. „Zapytaj asystenta” z palety poleceń): widok rozmowy
 * po otwarciu przejmuje zadanie i pokazuje wskaźnik pracy asystenta.
 */
const pending = new Map<string, string>();

export function setPendingTurn(conversationId: string, taskId: string): void {
  pending.set(conversationId, taskId);
}

/** Odczyt bez usuwania (inicjalizacja stanu może być wywołana dwa razy w trybie Strict). */
export function peekPendingTurn(conversationId: string): string | null {
  return pending.get(conversationId) ?? null;
}

export function clearPendingTurn(conversationId: string): void {
  pending.delete(conversationId);
}
