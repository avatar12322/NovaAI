import { describe, expect, it } from 'vitest';
import { createVad, recognitionErrorText, type VadVerdict } from './listen';

/** Przebieg poziomów dźwięku co 50 ms: [poziom, czas trwania w ms]…; zwraca pierwszy werdykt ≠ listen i jego czas. */
function run(segments: Array<[number, number]>): {
  verdict: VadVerdict;
  at: number;
  heard: boolean;
} {
  const vad = createVad();
  let at = 0;
  for (const [level, ms] of segments) {
    for (let t = 0; t < ms; t += 50) {
      at += 50;
      const verdict = vad.push(level, at);
      if (verdict !== 'listen') return { verdict, at, heard: vad.heard };
    }
  }
  return { verdict: 'listen', at, heard: vad.heard };
}

describe('koniec wypowiedzi po poziomie dźwięku', () => {
  it('mowa od razu po starcie, potem cisza — koniec po 1,2 s ciszy', () => {
    const r = run([
      [0.2, 1000],
      [0.001, 5000],
    ]);
    expect(r).toMatchObject({ verdict: 'end', heard: true });
    expect(r.at).toBe(1000 + 1200);
  });

  it('cisza, potem mowa, potem cisza', () => {
    const r = run([
      [0.002, 700],
      [0.1, 800],
      [0.002, 3000],
    ]);
    expect(r).toMatchObject({ verdict: 'end', heard: true });
    expect(r.at).toBe(700 + 800 + 1200);
  });

  it('sama cisza albo pojedynczy trzask — „nic nie słychać” po 8 s', () => {
    expect(run([[0.001, 10_000]])).toMatchObject({ verdict: 'no-speech', at: 8000, heard: false });
    expect(
      run([
        [0.001, 500],
        [0.5, 100],
        [0.001, 10_000],
      ]),
    ).toMatchObject({ verdict: 'no-speech', heard: false });
  });

  it('głośne tło: mowa wykryta ponad tłem, koniec po powrocie do tła', () => {
    const r = run([
      [0.03, 1000],
      [0.15, 1500],
      [0.03, 5000],
    ]);
    expect(r).toMatchObject({ verdict: 'end', heard: true });
    expect(r.at).toBe(1000 + 1500 + 1200);
  });

  it('ciągła mowa kończy się na limicie długości nagrania (30 s)', () => {
    expect(run([[0.2, 40_000]])).toMatchObject({ verdict: 'end', at: 30_000 });
  });
});

describe('komunikaty błędów rozpoznawania mowy', () => {
  it('każdy kod ma konkretną przyczynę i co zrobić', () => {
    expect(recognitionErrorText('network')).toMatch(/Brave, Opera i Vivaldi/);
    expect(recognitionErrorText('network')).toMatch(/Chrome lub Edge.*ELEVENLABS_API_KEY/);
    expect(recognitionErrorText('not-allowed')).toMatch(/Zezwól na mikrofon/);
    expect(recognitionErrorText('audio-capture')).toMatch(
      /brak mikrofonu albo używa go inna aplikacja/,
    );
    expect(recognitionErrorText('language-not-supported')).toMatch(/po polsku/);
    expect(recognitionErrorText('server', 'Wyczerpany limit')).toBe('Wyczerpany limit');
    expect(recognitionErrorText('bad-grammar')).toBe('Błąd rozpoznawania mowy (bad-grammar).');
  });
});
