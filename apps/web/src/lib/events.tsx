import type { NovaEvent } from '@nova/contracts';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type Listener = (e: NovaEvent) => void;

interface EventsCtx {
  connected: boolean;
  recent: NovaEvent[];
  subscribe(fn: Listener): () => void;
  onResync(fn: () => void): () => void;
}

const Ctx = createContext<EventsCtx>({
  connected: false,
  recent: [],
  subscribe: () => () => undefined,
  onResync: () => () => undefined,
});

const TYPES = [
  'task.created',
  'task.status',
  'task.progress',
  'step.status',
  'approval.requested',
  'approval.resolved',
  'message.created',
  'memory.changed',
  'notification.created',
  'budget.warning',
  'budget.blocked',
  'device.status',
];

/**
 * Strumień zdarzeń (SSE). EventSource sam wznawia połączenie i wysyła Last-Event-ID.
 * Zdarzenia zawierają tylko identyfikatory i statusy — widoki pobierają dane przez API.
 */
export function EventsProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [recent, setRecent] = useState<NovaEvent[]>([]);
  const listeners = useRef(new Set<Listener>());
  const resyncListeners = useRef(new Set<() => void>());

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/events/stream');
    es.onopen = () => {
      setConnected(true);
      // Po (ponownym) połączeniu widoki odświeżają stan — zdarzenia z przerwy mogły przepaść.
      resyncListeners.current.forEach((l) => l());
    };
    es.onerror = () => setConnected(false);
    const on = (m: MessageEvent<string>) => {
      try {
        const e = JSON.parse(m.data) as NovaEvent;
        setRecent((r) => [e, ...r.filter((x) => x.id !== e.id)].slice(0, 40));
        listeners.current.forEach((l) => l(e));
      } catch {
        /* ignoruj uszkodzone zdarzenie */
      }
    };
    TYPES.forEach((t) => es.addEventListener(t, on as EventListener));
    return () => es.close();
  }, []);

  const subscribe = (fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  };

  const onResync = (fn: () => void) => {
    resyncListeners.current.add(fn);
    return () => {
      resyncListeners.current.delete(fn);
    };
  };

  return <Ctx.Provider value={{ connected, recent, subscribe, onResync }}>{children}</Ctx.Provider>;
}

export const useEvents = () => useContext(Ctx);

/**
 * Wywołuje `fn` przy zdarzeniach spełniających filtr (np. odświeżenie listy) oraz po każdym
 * (ponownym) połączeniu strumienia — wtedy bez argumentu, jako pełne odświeżenie.
 */
export function useEventEffect(
  filter: (e: NovaEvent) => boolean,
  fn: (e?: NovaEvent) => void,
): void {
  const { subscribe, onResync } = useEvents();
  const f = useRef(filter);
  const cb = useRef(fn);
  f.current = filter;
  cb.current = fn;
  useEffect(() => {
    const a = subscribe((e) => {
      if (f.current(e)) cb.current(e);
    });
    const b = onResync(() => cb.current());
    return () => {
      a();
      b();
    };
  }, [subscribe, onResync]);
}
