import { useEffect, useState } from 'react';

/**
 * Minimalny router oparty o hash (#/chat/private/<id>). Brak zależności, działa w PWA offline.
 */
export type Route =
  | { view: 'chat'; space: 'private' | 'shared'; id: string | null }
  | { view: 'tasks'; id: string | null }
  | { view: 'approvals' }
  | { view: 'memory'; space: 'private' | 'shared' }
  | { view: 'documents'; space: 'private' | 'shared' }
  | { view: 'document'; id: string; ord: number | null }
  | { view: 'services'; id: string | null }
  | { view: 'models' }
  | { view: 'expenses' }
  | { view: 'home' }
  | { view: 'settings' }
  | { view: 'enroll'; token: string };

const UUID = /^[0-9a-f-]{36}$/i;

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('?')[0]!.split('/').filter(Boolean);
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
    case 'documents':
      if (b && UUID.test(b)) {
        return { view: 'document', id: b, ord: c && /^\d{1,6}$/.test(c) ? Number(c) : null };
      }
      return { view: 'documents', space: b === 'shared' ? 'shared' : 'private' };
    case 'services':
      return { view: 'services', id: b && UUID.test(b) ? b : null };
    case 'models':
      return { view: 'models' };
    case 'expenses':
      return { view: 'expenses' };
    case 'home':
      return { view: 'home' };
    case 'settings':
      return { view: 'settings' };
    case 'enroll':
      return b && /^[A-Za-z0-9_-]{20,200}$/.test(b)
        ? { view: 'enroll', token: b }
        : { view: 'chat', space: 'private', id: null };
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
    case 'documents':
      return `#/documents/${r.space}`;
    case 'document':
      return `#/documents/${r.id}${r.ord !== null ? `/${r.ord}` : ''}`;
    case 'enroll':
      return `#/enroll/${r.token}`;
    case 'services':
      return `#/services${r.id ? `/${r.id}` : ''}`;
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
