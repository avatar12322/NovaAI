import { useEffect, useState } from 'react';

/**
 * Minimalny router oparty o hash (#/chat/private/<id>). Brak zależności, działa w PWA offline.
 */
export type Route =
  | { view: 'chat'; space: 'private' | 'shared'; id: string | null }
  | { view: 'tasks'; id: string | null }
  | { view: 'approvals' }
  | { view: 'memory'; space: 'private' | 'shared' }
  | { view: 'home' }
  | { view: 'settings' };

const UUID = /^[0-9a-f-]{36}$/i;

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [a, b, c] = parts;
  switch (a) {
    case 'chat':
      return {
        view: 'chat',
        space: b === 'shared' ? 'shared' : 'private',
        id: c && UUID.test(c) ? c : null,
      };
    case 'tasks':
      return { view: 'tasks', id: b && UUID.test(b) ? b : null };
    case 'approvals':
      return { view: 'approvals' };
    case 'memory':
      return { view: 'memory', space: b === 'shared' ? 'shared' : 'private' };
    case 'home':
      return { view: 'home' };
    case 'settings':
      return { view: 'settings' };
    default:
      return { view: 'chat', space: 'private', id: null };
  }
}

export function href(r: Route): string {
  switch (r.view) {
    case 'chat':
      return `#/chat/${r.space}${r.id ? `/${r.id}` : ''}`;
    case 'tasks':
      return `#/tasks${r.id ? `/${r.id}` : ''}`;
    case 'memory':
      return `#/memory/${r.space}`;
    default:
      return `#/${r.view}`;
  }
}

export function navigate(r: Route): void {
  window.location.hash = href(r);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
