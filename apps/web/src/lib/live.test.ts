import type { MessageDelta } from '@nova/contracts';
import { describe, expect, it } from 'vitest';
import { applyDelta, sameText } from './live';

const d = (over: Partial<MessageDelta>): MessageDelta => ({
  conversationId: 'c',
  taskId: 't',
  step: 'reply',
  attempt: 0,
  offset: 0,
  delta: '',
  ...over,
});

describe('odpowiedź na żywo', () => {
  it('dokleja ciągłe fragmenty; luka i powtórka są pomijane', () => {
    let s = applyDelta(null, d({ delta: 'Dzień ' }));
    s = applyDelta(s, d({ offset: 6, delta: 'dobry' }));
    expect(s?.text).toBe('Dzień dobry');
    expect(applyDelta(s, d({ offset: 6, delta: 'dobry' }))?.text).toBe('Dzień dobry');
    expect(applyDelta(s, d({ offset: 40, delta: '???' }))?.text).toBe('Dzień dobry');
    // Bez początku (zgubiony pierwszy fragment) nic nie pokazujemy.
    expect(applyDelta(null, d({ offset: 5, delta: 'x' }))).toBeNull();
  });

  it('nowy krok albo nowa próba zaczyna od zera; spóźniona starsza próba jest ignorowana', () => {
    const first = applyDelta(null, d({ delta: 'Sprawdzam.' }));
    const follow = applyDelta(first, d({ step: 'followup', delta: 'Wynik: ' }));
    expect(follow).toMatchObject({ step: 'followup', text: 'Wynik: ' });
    const retry = applyDelta(first, d({ attempt: 1, delta: 'Inny model.' }));
    expect(retry).toMatchObject({ attempt: 1, text: 'Inny model.' });
    expect(applyDelta(retry, d({ attempt: 0, offset: 10, delta: ' stare' }))).toBe(retry);
  });

  it('porównanie z zapisaną odpowiedzią ignoruje różnice białych znaków', () => {
    expect(sameText('Ala  ma\nkota. ', 'Ala ma kota.')).toBe(true);
    expect(sameText('Ala ma kota', 'Ala ma psa')).toBe(false);
  });
});
