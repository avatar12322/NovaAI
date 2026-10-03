import { describe, expect, it } from 'vitest';
import { historyWindow } from './context';

describe('historyWindow', () => {
  it('do 20 wiadomości — cała rozmowa; dalej okno przesuwa się skokami co 10 (stały początek dla cache)', () => {
    expect(historyWindow(0)).toBe(0);
    expect(historyWindow(20)).toBe(20);
    expect(historyWindow(21)).toBe(21);
    expect(historyWindow(29)).toBe(29);
    expect(historyWindow(30)).toBe(20);
    // Pierwsza wiadomość w oknie (total − okno) zmienia się tylko co 10 wiadomości.
    const starts = [24, 25, 26, 27, 28, 29, 30, 31].map((n) => n - historyWindow(n));
    expect(starts).toEqual([0, 0, 0, 0, 0, 0, 10, 10]);
  });
});
