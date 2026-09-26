import type { MessageDelta } from '@nova/contracts';

/**
 * Zdarzenia ulotne (na żywo), bez zapisu w bazie: fragmenty odpowiedzi modelu w trakcie pisania.
 * Działają w procesie, który wykonuje turę i obsługuje strumień SSE (jedna instancja API — D-024);
 * przy innym układzie klient i tak dostaje pełną odpowiedź zwykłym zdarzeniem `message.created`.
 * Odbiorcy jak dla rozmowy: prywatna — tylko właściciel, wspólna — aktywni członkowie domu.
 */
export interface LiveTarget {
  householdId: string;
  ownerUserId: string;
  visibility: 'private' | 'shared';
}

export interface LiveEvent {
  type: 'message.delta';
  target: LiveTarget;
  payload: MessageDelta;
}

export function canSee(
  target: LiveTarget,
  viewer: { userId: string; activeHouseholdIds: ReadonlySet<string> },
): boolean {
  if (!viewer.activeHouseholdIds.has(target.householdId)) return false;
  return target.visibility === 'shared' || target.ownerUserId === viewer.userId;
}

export class LiveHub {
  private readonly listeners = new Set<(e: LiveEvent) => void>();

  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(e: LiveEvent): void {
    for (const l of this.listeners) l(e);
  }
}

/** Strumień tekstu jednej odpowiedzi: `reset` przy każdej próbie modelu, `push` z fragmentem. */
export interface TextStream {
  reset(): void;
  push(delta: string): void;
}

const FLUSH_MS = 50;

/**
 * Fragmenty łączone i wysyłane co ~50 ms (mniej zdarzeń przy szybkim modelu). Każde zdarzenie niesie
 * przesunięcie — klient dokleja tylko ciągłe fragmenty, a luki uzupełnia pełna wiadomość na końcu.
 */
export function liveTextStream(
  hub: LiveHub,
  target: LiveTarget,
  base: Pick<MessageDelta, 'conversationId' | 'taskId' | 'step'>,
): TextStream & { flush(): void } {
  let sent = 0;
  let attempt = 0;
  let pending = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    hub.publish({
      type: 'message.delta',
      target,
      payload: { ...base, attempt, offset: sent, delta: pending },
    });
    sent += pending.length;
    pending = '';
  };
  return {
    reset() {
      flush();
      if (sent > 0) attempt++;
      sent = 0;
    },
    push(delta: string) {
      if (!delta) return;
      pending += delta;
      timer ??= setTimeout(flush, FLUSH_MS);
    },
    flush,
  };
}
