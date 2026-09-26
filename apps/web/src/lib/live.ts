import type { MessageDelta } from '@nova/contracts';

/** Odpowiedź asystenta w trakcie pisania (z fragmentów `message.delta`). */
export interface LiveReply {
  taskId: string;
  step: string;
  attempt: number;
  text: string;
}

/**
 * Doklejenie fragmentu: tylko ciągłe fragmenty tej samej tury/kroku/próby. Nowy krok lub nowa próba zaczyna
 * od zera; fragment z luką albo powtórzony jest pomijany — pełną odpowiedź i tak przyniesie `message.created`.
 */
export function applyDelta(state: LiveReply | null, d: MessageDelta): LiveReply | null {
  const same =
    state !== null &&
    state.taskId === d.taskId &&
    state.step === d.step &&
    state.attempt === d.attempt;
  if (!same) {
    if (state && state.taskId === d.taskId && state.step === d.step && d.attempt < state.attempt)
      return state; // spóźniony fragment starszej próby
    return d.offset === 0
      ? { taskId: d.taskId, step: d.step, attempt: d.attempt, text: d.delta }
      : state;
  }
  return d.offset === state.text.length ? { ...state, text: state.text + d.delta } : state;
}

/** Porównanie tekstu na żywo z zapisaną odpowiedzią (dostawca może inaczej łączyć bloki i spacje). */
export const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
