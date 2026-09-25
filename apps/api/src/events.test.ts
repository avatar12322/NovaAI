import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, login, type Client, type TestApp } from './test/helpers';

/** SSE: zdarzenia docierają na żywo, filtrowane RLS odbiorcy. */
let t: TestApp;
let base: string;
let alfa: Client;
let beta: Client;

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  alfa = await login(t.app, 'alfa');
  beta = await login(t.app, 'beta');
});
afterAll(async () => t.close());

interface Sse {
  events: Array<{
    id: number;
    type: string;
    taskId: string | null;
    payload: Record<string, unknown>;
  }>;
  waitFor(pred: (e: Sse['events'][number]) => boolean, ms?: number): Promise<Sse['events'][number]>;
  close(): void;
}

async function openStream(cookie: string, after = 0): Promise<Sse> {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events/stream?after=${after}`, {
    headers: { cookie },
    signal: ctrl.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const events: Sse['events'] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = chunk
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('');
          if (data) events.push(JSON.parse(data));
        }
      }
    } catch {
      /* zamknięte */
    }
  })();
  return {
    events,
    async waitFor(pred, ms = 3000) {
      const start = Date.now();
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() - start > ms)
          throw new Error(`timeout; got ${events.map((e) => e.type).join(',')}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    close: () => ctrl.abort(),
  };
}

describe('strumień zdarzeń SSE', () => {
  it('Beta dostaje na żywo zdarzenia wspólne, ale nie prywatne Alfy', async () => {
    const lastId = (await beta.get('/api/events')).body.lastId as number;
    const stream = await openStream(beta.cookie, lastId);
    try {
      const priv = await alfa.post('/api/conversations', { space: 'private' });
      await alfa.post(`/api/conversations/${priv.body.id}/messages`, { content: 'sekret Alfy' });
      const shared = await alfa.post('/api/conversations', { space: 'shared' });
      await alfa.post(`/api/conversations/${shared.body.id}/messages`, { content: 'hej' });
      await t.drain();

      const e = await stream.waitFor(
        (x) =>
          x.type === 'message.created' &&
          x.payload.role === 'assistant' &&
          x.payload.conversationId === shared.body.id,
      );
      expect(e.payload).not.toHaveProperty('content');
      expect(stream.events.some((x) => x.payload.conversationId === priv.body.id)).toBe(false);
      const privTask = await t.db.owner.query(`SELECT id FROM tasks WHERE conversation_id = $1`, [
        priv.body.id,
      ]);
      expect(stream.events.some((x) => x.taskId === privTask.rows[0].id)).toBe(false);
    } finally {
      stream.close();
    }
  });

  it('wznowienie od Last-Event-ID dostarcza zaległe zdarzenia', async () => {
    const before = (await alfa.get('/api/events')).body.lastId as number;
    const r = await alfa.post('/api/tasks', { kind: 'demo.workflow', message: 'x' });
    const stream = await openStream(alfa.cookie, before);
    try {
      const e = await stream.waitFor((x) => x.type === 'task.created' && x.taskId === r.body.id);
      expect(e.payload.title).toBe('Zadanie demonstracyjne');
    } finally {
      stream.close();
    }
  });

  it('nowe połączenie bez Last-Event-ID nie odtwarza historii, tylko nowe zdarzenia', async () => {
    const old = await alfa.post('/api/tasks', { kind: 'demo.workflow', message: 'stare' });
    const stream = await openStream(alfa.cookie, 0);
    try {
      await new Promise((r) => setTimeout(r, 100));
      const fresh = await alfa.post('/api/tasks', { kind: 'demo.workflow', message: 'nowe' });
      await stream.waitFor((x) => x.type === 'task.created' && x.taskId === fresh.body.id);
      expect(stream.events.some((x) => x.taskId === old.body.id)).toBe(false);
    } finally {
      stream.close();
    }
  });

  it('bez sesji strumień jest niedostępny', async () => {
    const res = await fetch(`${base}/api/events/stream`);
    expect(res.status).toBe(401);
  });
});
