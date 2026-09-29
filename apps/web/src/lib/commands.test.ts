import { describe, expect, it } from 'vitest';
import { COMMANDS, matchCommands } from './commands';

describe('paleta poleceń', () => {
  it('pusty tekst — wszystkie polecenia', () => {
    expect(matchCommands('')).toHaveLength(COMMANDS.length);
  });
  it('dopasowanie po słowach, bez polskich znaków i wielkości liter', () => {
    expect(matchCommands('zadania')[0]!.id).toBe('tasks');
    expect(matchCommands('USLUGI')[0]!.id).toBe('services');
    expect(matchCommands('klucze api')[0]!.id).toBe('models');
    expect(matchCommands('przeglad')[0]!.id).toBe('home');
  });
  it('pytanie albo tekst bez dopasowania — „Zapytaj asystenta” na początku', () => {
    expect(matchCommands('co mam dziś w planie?')[0]!.id).toBe('ask');
    expect(matchCommands('xyz')[0]!.id).toBe('ask');
    expect(matchCommands('zadania').at(-1)!.id).toBe('ask');
  });
  it('domownik (nie właściciel) nie widzi modeli, usług ani zadań', () => {
    const ids = matchCommands('', false).map((c) => c.id);
    expect(ids).not.toContain('models');
    expect(ids).not.toContain('services');
    expect(ids).not.toContain('tasks');
    expect(ids).toContain('documents');
    expect(matchCommands('klucze api', false)[0]!.id).toBe('ask');
  });
});
