import { describe, expect, it } from 'vitest';
import { RateLimiter, redactUrl } from './rate-limit';

describe('limiter i redakcja URL', () => {
  it('limit w oknie i reset po czasie', () => {
    const l = new RateLimiter(2, 1000);
    expect(l.hit('a', 0)).toBe(true);
    expect(l.hit('a', 10)).toBe(true);
    expect(l.hit('a', 20)).toBe(false);
    expect(l.hit('b', 20)).toBe(true);
    expect(l.hit('a', 1500)).toBe(true);
  });
  it('kody OAuth i tokeny nie trafiają do logów', () => {
    expect(redactUrl('/api/connections/google/callback?code=4/abc&state=xyz&scope=a')).toBe(
      '/api/connections/google/callback?code=%5Bredacted%5D&state=%5Bredacted%5D&scope=a',
    );
    expect(redactUrl('/api/health')).toBe('/api/health');
  });
});
