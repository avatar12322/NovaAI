import type { MessageDelta, NovaEvent } from '@nova/contracts';
import { EVENT_TYPES } from '@nova/contracts/event-types';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type Listener = (e: NovaEvent) => void;
type DeltaListener = (d: MessageDelta) => void;

interface EventsCtx {
  connected: boolean;
  subscribe(fn: Listener): () => void;
  onResync(fn: () => void): () => void;
  /** Tekst odpowiedzi na żywo (ulotne `message.delta` — poza listą aktywności). */
  subscribeDelta(fn: DeltaListener): () => void;
}

const Ctx = createContext<EventsCtx>({
  connected: false,
  subscribe: () => () => undefined,
  onResync: () => () => undefined,
  subscribeDelta: () => () => undefined,
});

/**
 * Strumień zdarzeń (SSE). EventSource sam wznawia połączenie i wysyła Last-Event-ID.
 * Zdarzenia zawierają tylko identyfikatory i statusy — widoki pobierają dane przez API.
 */
export function EventsProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());
  const resyncListeners = useRef(new Set<() => void>());
  const deltaListeners = useRef(new Set<DeltaListener>());

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
        listeners.current.forEach((l) => l(e));
      } catch {
        /* ignoruj uszkodzone zdarzenie */
      }
    };
    EVENT_TYPES.forEach((t) => es.addEventListener(t, on as EventListener));
    es.addEventListener('message.delta', ((m: MessageEvent<string>) => {
      try {
        const d = JSON.parse(m.data) as MessageDelta;
        deltaListeners.current.forEach((l) => l(d));
      } catch {
        /* ignoruj uszkodzony fragment */
      }
    }) as EventListener);
    return () => es.close();
  }, []);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const onResync = useCallback((fn: () => void) => {
    resyncListeners.current.add(fn);
    return () => {
      resyncListeners.current.delete(fn);
    };
  }, []);

  const subscribeDelta = useCallback((fn: DeltaListener) => {
    deltaListeners.current.add(fn);
    return () => {
      deltaListeners.current.delete(fn);
    };
  }, []);

  return (
    <Ctx.Provider value={{ connected, subscribe, onResync, subscribeDelta }}>
      {children}
    </Ctx.Provider>
  );
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

/** Fragmenty odpowiedzi na żywo dla jednej rozmowy. */
export function useDeltaEffect(conversationId: string, fn: (d: MessageDelta) => void): void {
  const { subscribeDelta } = useEvents();
  const cb = useRef(fn);
  cb.current = fn;
  useEffect(() => {
    const off = subscribeDelta((d) => {
      if (d.conversationId === conversationId) cb.current(d);
    });
    return off;
  }, [subscribeDelta, conversationId]);
}
