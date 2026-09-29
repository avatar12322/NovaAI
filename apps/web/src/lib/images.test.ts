import { describe, expect, it } from 'vitest';
import { fitSize } from './images';

describe('fitSize', () => {
  it('zmniejsza dłuższy bok do limitu, bez powiększania małych zdjęć', () => {
    expect(fitSize(4032, 3024)).toEqual({ w: 1600, h: 1200 });
    expect(fitSize(3024, 4032)).toEqual({ w: 1200, h: 1600 });
    expect(fitSize(800, 600)).toEqual({ w: 800, h: 600 });
  });
});
