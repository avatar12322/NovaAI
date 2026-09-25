import { describe, expect, it } from 'vitest';
import { CreateMemoryRequest, LIMITS, ListConversationsQuery, PostMessageRequest } from './index';

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
