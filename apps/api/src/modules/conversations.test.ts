import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, login, type TestApp } from '../test/helpers';
import { shortText } from './conversations';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

describe('tytuły rozmów i zadań', () => {
  it('pierwsza wiadomość nadaje tytuł rozmowie; kolejne go nie zmieniają; własny tytuł zostaje', async () => {
    const alfa = await login(t.app, 'alfa');
    const conv = (await alfa.post('/api/conversations', { space: 'private' })).body;
    expect(conv.title).toBe('Nowa rozmowa');
    await alfa.post(`/api/conversations/${conv.id}/messages`, {
      content:
        'Jakie   powinno być ciśnienie w piecu gazowym w zimie, gdy grzejniki są zimne?\nDruga linia',
    });
    await alfa.post(`/api/conversations/${conv.id}/messages`, { content: 'I jeszcze jedno' });
    const after = (await alfa.get(`/api/conversations/${conv.id}`)).body;
    expect(after.title).toBe('Jakie powinno być ciśnienie w piecu gazowym w zimie, gdy…');
    const tasks = await t.db.owner.query(
      `SELECT title FROM tasks WHERE conversation_id = $1 ORDER BY created_at`,
      [conv.id],
    );
    expect(tasks.rows.map((r) => r.title)).toEqual([
      'Odpowiedź: „Jakie powinno być ciśnienie w piecu gazowym w…”',
      'Odpowiedź: „I jeszcze jedno”',
    ]);

    const named = (await alfa.post('/api/conversations', { space: 'private', title: 'Wakacje' }))
      .body;
    await alfa.post(`/api/conversations/${named.id}/messages`, { content: 'Dokąd jedziemy?' });
    expect((await alfa.get(`/api/conversations/${named.id}`)).body.title).toBe('Wakacje');
  });
  it('skrót tekstu: pierwsza linia, bez nadmiarowych spacji', () => {
    expect(shortText('  a   b \n c', 10)).toBe('a b');
    expect(shortText('abcdefghij', 5)).toBe('abcd…');
  });
});
