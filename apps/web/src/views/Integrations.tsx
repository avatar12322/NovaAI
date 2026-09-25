import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, ErrorNote, Spinner } from '../components/ui';
import { api, ApiError, type ConnectionInfo, type LocalEvent } from '../lib/api';

const CAP_PL: Record<string, string> = {
  'calendar.freebusy': 'zajętość kalendarza',
  'mail.search': 'wyszukiwanie poczty',
  'mail.read': 'odczyt poczty',
  'mail.send': 'wysyłka poczty (zawsze ze zgodą)',
};

/** Integracje: tylko rzeczywiście połączone i skonfigurowane usługi są oznaczone jako dostępne. */
export function IntegrationsPanel() {
  const [items, setItems] = useState<ConnectionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .connections()
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Błąd'));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const st = q.get('integration');
    if (st === 'ok') setNotice('Połączono konto.');
    if (st === 'error') setNotice(`Nie udało się połączyć konta (${q.get('reason') ?? 'błąd'}).`);
  }, []);

  const connect = async (c: ConnectionInfo) => {
    try {
      const { url } = await api.startConnection(c.provider, c.capabilities);
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Błąd');
    }
  };

  return (
    <section className="panel">
      <h2 className="h-sub">Integracje</h2>
      {notice && <p className="note note-muted">{notice}</p>}
      {error && <ErrorNote error={error} onRetry={load} />}
      {!items && !error && <Spinner />}
      <ul className="devices">
        {items?.map((c) => (
          <li key={c.provider} className="device">
            <div className="row between">
              <div>
                <strong>{c.title}</strong>
                <div className="row small">
                  {!c.configured ? (
                    <Badge>niedostępne: {c.reason}</Badge>
                  ) : c.connection?.status === 'connected' ? (
                    <Badge tone="ok">połączono</Badge>
                  ) : c.connection?.status === 'error' ? (
                    <Badge tone="danger">wymaga ponownego połączenia</Badge>
                  ) : (
                    <Badge>nie połączono</Badge>
                  )}
                </div>
              </div>
              {c.configured &&
                (c.connection && c.connection.status !== 'revoked' ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm danger"
                    onClick={() => void api.disconnect(c.provider).then(load)}
                  >
                    Odłącz
                  </button>
                ) : (
                  <button type="button" className="btn btn-sm" onClick={() => void connect(c)}>
                    Połącz
                  </button>
                ))}
            </div>
            {c.capabilities.length > 0 && (
              <p className="small muted">
                Zakres: {c.capabilities.map((x) => CAP_PL[x] ?? x).join(', ')}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const toLocalInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** Kalendarz: jawny grant free/busy dla NovaAI + kalendarz lokalny (bez OAuth). */
export function CalendarPanel() {
  const [grant, setGrant] = useState<boolean | null>(null);
  const [events, setEvents] = useState<LocalEvent[]>([]);
  const [title, setTitle] = useState('');
  const [start, setStart] = useState(() => toLocalInput(new Date(Date.now() + 3600_000)));
  const [end, setEnd] = useState(() => toLocalInput(new Date(Date.now() + 7200_000)));
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    Promise.all([api.freeBusyGrant(), api.localEvents()])
      .then(([g, e]) => {
        setGrant(g.active);
        setEvents(e.items);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Błąd'));
  }, []);
  useEffect(load, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.addLocalEvent({
        title: title.trim(),
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(end).toISOString(),
      });
      setTitle('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Błąd');
    }
  };

  return (
    <section className="panel">
      <h2 className="h-sub">Kalendarz</h2>
      {error && <ErrorNote error={error} />}
      <label className="row">
        <input
          type="checkbox"
          checked={grant ?? false}
          disabled={grant === null}
          onChange={(e) => void api.setFreeBusyGrant(e.target.checked).then(load)}
          style={{ width: 'auto', minHeight: 0 }}
        />
        <span>
          Udostępnij NovaAI moją zajętość (tylko przedziały „zajęty”, bez tytułów i szczegółów)
        </span>
      </label>
      <h3 className="small muted">Kalendarz lokalny (prywatny)</h3>
      <form className="grant-form" onSubmit={(e) => void add(e)}>
        <label htmlFor="ev-title" className="sr-only">
          Tytuł
        </label>
        <input
          id="ev-title"
          placeholder="Tytuł (prywatny)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <label htmlFor="ev-start" className="sr-only">
          Początek
        </label>
        <input
          id="ev-start"
          type="datetime-local"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          required
        />
        <label htmlFor="ev-end" className="sr-only">
          Koniec
        </label>
        <input
          id="ev-end"
          type="datetime-local"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          required
        />
        <button type="submit" className="btn btn-sm" disabled={!title.trim()}>
          Dodaj
        </button>
      </form>
      <ul className="grants">
        {events.map((ev) => (
          <li key={ev.id} className="row between">
            <span>
              {new Date(ev.startsAt).toLocaleString('pl-PL', {
                dateStyle: 'short',
                timeStyle: 'short',
              })}{' '}
              – {ev.title}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void api.deleteLocalEvent(ev.id).then(load)}
            >
              Usuń
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
