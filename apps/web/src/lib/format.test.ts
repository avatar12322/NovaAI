import { describe, expect, it } from 'vitest';
import { stepErrorPl, plural } from './format';

describe('stepErrorPl', () => {
  it('odmowy integracji jako czytelny komunikat, inne błędy bez zmian', () => {
    expect(stepErrorPl('Odmowa: connector:reauth_required')).toContain('połącz je ponownie');
    expect(stepErrorPl('Odmowa: connector:not_connected')).toContain('nie jest połączone');
    expect(stepErrorPl('Odmowa: connector:nieznany')).toBe('Odmowa: connector:nieznany');
    expect(stepErrorPl('Odmowa: tool_not_in_context')).toBe('Odmowa: tool_not_in_context');
  });
});

describe('odmiana liczebników', () => {
  it('1, 2–4, 5+, 12–14, 22', () => {
    const f = (n: number) => plural(n, 'wydarzenie', 'wydarzenia', 'wydarzeń');
    expect([0, 1, 2, 4, 5, 12, 14, 22, 25, 112].map(f)).toEqual([
      '0 wydarzeń',
      '1 wydarzenie',
      '2 wydarzenia',
      '4 wydarzenia',
      '5 wydarzeń',
      '12 wydarzeń',
      '14 wydarzeń',
      '22 wydarzenia',
      '25 wydarzeń',
      '112 wydarzeń',
    ]);
  });
});
