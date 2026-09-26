import { describe, expect, it } from 'vitest';
import { stepErrorPl } from './format';

describe('stepErrorPl', () => {
  it('odmowy integracji jako czytelny komunikat, inne błędy bez zmian', () => {
    expect(stepErrorPl('Odmowa: connector:reauth_required')).toContain('połącz je ponownie');
    expect(stepErrorPl('Odmowa: connector:not_connected')).toContain('nie jest połączone');
    expect(stepErrorPl('Odmowa: connector:nieznany')).toBe('Odmowa: connector:nieznany');
    expect(stepErrorPl('Odmowa: tool_not_in_context')).toBe('Odmowa: tool_not_in_context');
  });
});
