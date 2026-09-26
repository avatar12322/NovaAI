import { describe, expect, it } from 'vitest';
import { REVEAL_MAX_MS, REVEAL_MIN_MS, revealDuration, revealedText } from './reveal';

describe('odsłanianie odpowiedzi', () => {
  it('czas zależy od długości, ale mieści się w granicach', () => {
    expect(revealDuration('ok')).toBe(REVEAL_MIN_MS);
    expect(revealDuration('x'.repeat(100))).toBe(600);
    expect(revealDuration('x'.repeat(10_000))).toBe(REVEAL_MAX_MS);
  });

  it('odsłania całe słowa, rośnie monotonicznie i kończy się pełnym tekstem', () => {
    const text = 'Kaucja wynosi 3000 zł i jest zwracana w ciągu 30 dni.';
    const d = revealDuration(text);
    expect(revealedText(text, 0, d)).toBe('');
    let prev = '';
    for (let t = 1; t <= d; t += 17) {
      const shown = revealedText(text, t, d);
      expect(text.startsWith(shown)).toBe(true);
      expect(shown.length).toBeGreaterThanOrEqual(prev.length);
      // Nigdy w połowie słowa: po widocznym tekście jest koniec albo biały znak.
      const next = text[shown.length];
      expect(next === undefined || /\s/.test(next)).toBe(true);
      prev = shown;
    }
    expect(revealedText(text, d, d)).toBe(text);
    expect(revealedText(text, d + 500, d)).toBe(text);
  });
});
