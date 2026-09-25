import { describe, expect, it } from 'vitest';
import { href, parseRoute } from './router';

describe('router', () => {
  it('parsuje i buduje ścieżki', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(parseRoute(`#/chat/shared/${id}`)).toEqual({ view: 'chat', space: 'shared', id });
    expect(parseRoute('#/tasks')).toEqual({ view: 'tasks', id: null });
    expect(parseRoute('#/memory/shared')).toEqual({ view: 'memory', space: 'shared' });
    expect(parseRoute('')).toEqual({ view: 'chat', space: 'private', id: null });
    expect(href({ view: 'chat', space: 'private', id })).toBe(`#/chat/private/${id}`);
  });
  it('odrzuca identyfikatory niebędące UUID', () => {
    expect(parseRoute('#/tasks/../../etc')).toEqual({ view: 'tasks', id: null });
  });
});
