/**
 * Odsłanianie nowej odpowiedzi asystenta (efekt „pisania”). Czas zależy od długości, ale jest ograniczony,
 * żeby długa odpowiedź nie kazała czekać; tekst odsłaniany jest całymi słowami.
 */
export const REVEAL_MIN_MS = 350;
export const REVEAL_MAX_MS = 1600;
const MS_PER_CHAR = 6;

export function revealDuration(text: string): number {
  return Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, text.length * MS_PER_CHAR));
}

/** Tekst widoczny po `elapsed` ms — prefiks kończący się na granicy słowa (bez ucinania w połowie). */
export function revealedText(
  text: string,
  elapsed: number,
  duration = revealDuration(text),
): string {
  if (elapsed <= 0) return '';
  if (elapsed >= duration) return text;
  let end = Math.ceil(text.length * (elapsed / duration));
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return text.slice(0, end);
}

/** Ustawienie systemu „ogranicz ruch” — wtedy bez animacji odsłaniania. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
