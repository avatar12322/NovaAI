import { describe, expect, it } from 'vitest';
import {
  CreateMemoryRequest,
  CreateModelProvider,
  LIMITS,
  ListConversationsQuery,
  PostMessageRequest,
  safeBaseUrl,
  UpdateModelProvider,
} from './index';

describe('kontrakty wejścia', () => {
  it('wiadomość: trim, niepusta, limit długości', () => {
    expect(PostMessageRequest.parse({ content: '  hej  ' }).content).toBe('hej');
    expect(PostMessageRequest.safeParse({ content: '   ' }).success).toBe(false);
    expect(
      PostMessageRequest.safeParse({ content: 'x'.repeat(LIMITS.messageChars + 1) }).success,
    ).toBe(false);
  });
  it('pamięć: domyślnie prywatna i typu profile', () => {
    expect(CreateMemoryRequest.parse({ content: 'fakt' })).toEqual({
      kind: 'profile',
      space: 'private',
      content: 'fakt',
    });
  });
  it('lista rozmów: limit z query string i ograniczenie do 100', () => {
    expect(ListConversationsQuery.parse({ limit: '5' }).limit).toBe(5);
    expect(ListConversationsQuery.safeParse({ limit: '1000' }).success).toBe(false);
  });
  it('nie przyjmuje ownerUserId od klienta (pole ignorowane)', () => {
    const parsed = CreateMemoryRequest.parse({ content: 'x', ownerUserId: 'someone-else' });
    expect('ownerUserId' in parsed).toBe(false);
  });
});

describe('Modele AI i klucze API', () => {
  it('adres serwera: https albo localhost, bez danych logowania i parametrów', () => {
    expect(safeBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(safeBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(safeBaseUrl('http://127.0.0.1/v1')).toBe('http://127.0.0.1/v1');
    expect(safeBaseUrl('http://example.com/v1')).toBeNull();
    expect(safeBaseUrl('http://localhost.evil.test/v1')).toBeNull();
    expect(safeBaseUrl('https://u:p@example.com/v1')).toBeNull();
    expect(safeBaseUrl('https://example.com/v1?key=abc')).toBeNull();
    expect(safeBaseUrl('ftp://example.com')).toBeNull();
  });
  it('klucz API: bez spacji, rozsądna długość; nazwa dostawcy: małe litery', () => {
    const base = { name: 'openai', label: 'OpenAI', kind: 'openai_compatible' as const };
    expect(CreateModelProvider.safeParse({ ...base, apiKey: 'sk-' + 'a'.repeat(40) }).success).toBe(
      true,
    );
    expect(CreateModelProvider.safeParse({ ...base, apiKey: 'krótki' }).success).toBe(false);
    expect(CreateModelProvider.safeParse({ ...base, apiKey: 'sk a'.repeat(10) }).success).toBe(
      false,
    );
    expect(CreateModelProvider.safeParse({ ...base, name: 'OpenAI' }).success).toBe(false);
    expect(
      UpdateModelProvider.safeParse({ apiKey: 'sk-' + 'a'.repeat(40), removeKey: true }).success,
    ).toBe(false);
  });
});
