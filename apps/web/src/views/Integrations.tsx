import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, ErrorNote, Spinner } from '../components/ui';
import { api, ApiError, type ConnectionInfo, type LocalEvent } from '../lib/api';

const CAP_PL: Record<string, string> = {
  'mail.search': 'Wyszukiwanie poczty (nadawca, temat, data)',
  'mail.read': 'Odczyt treści wiadomości',
  'mail.send': 'Wysyłka e-maili — zawsze po Twojej zgodzie',
  'mail.draft': 'Szkice e-maili w Outlooku — zawsze po Twojej zgodzie',
  'calendar.freebusy': 'Zajętość kalendarza (bez szczegółów wydarzeń)',
  'calendar.read': 'Odczyt wydarzeń (tytuł, czas, miejsce) — tylko prywatny asystent',
  'chat.read': 'Wzmianki i wiadomości z kanałów publicznych, do których należysz',
  'chat.read_private': 'Także Twoje kanały prywatne',
  'chat.read_dm': 'Także rozmowy bezpośrednie i grupowe',
  'chat.send': 'Wysyłanie wiadomości jako Ty — zawsze po Twojej zgodzie',
};

/** Domyślnie tylko odczyt; działania ze skutkami (wysyłka, szkice) użytkownik włącza świadomie. */
const OPT_IN = new Set([
  'mail.send',
  'mail.draft',
  'chat.send',
  'chat.read_private',
  'chat.read_dm',
]);

const PROVIDER_PL: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  slack: 'Slack',
};

/** Powody z przekierowania po logowaniu u dostawcy (parametr `reason`). */
const REASON_PL: Record<string, string> = {
  zgoda_administratora:
    'organizacja wymaga zgody administratora dla tej aplikacji. Poproś administratora Microsoft 365 o jej zatwierdzenie albo połącz konto osobiste.',
  odmowa: 'nie udzielono zgody na dostęp.',
  nieprawidlowe_zadanie: 'nieprawidłowa odpowiedź logowania — spróbuj ponownie.',
  not_connected: 'sesja logowania wygasła lub została już użyta — spróbuj ponownie.',
  reauth_required: 'logowanie nie zostało potwierdzone przez dostawcę — spróbuj ponownie.',
  provider_error: 'dostawca odrzucił logowanie (sprawdź konfigurację aplikacji OAuth na serwerze).',
  not_configured: 'integracja nie jest skonfigurowana na serwerze.',
  account_in_use:
    'to konto jest już połączone przez inną osobę w NovaAI. Każda osoba łączy własne konto.',
};

/** Integracje: tylko rzeczywiście połączone i skonfigurowane usługi są oznaczone jako dostępne. */
export function IntegrationsPanel() {
  const [items, setItems] = useState<ConnectionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'muted' | 'warn' } | null>(null);

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
    const [path, query] = window.location.hash.split('?');
    const q = new URLSearchParams(query ?? '');
    const st = q.get('integration');
    if (!st) return;
    const who = PROVIDER_PL[q.get('provider') ?? ''] ?? '';
    const reason = q.get('reason') ?? '';
    if (st === 'ok')
      setNotice({ text: who ? `Połączono konto ${who}.` : 'Połączono konto.', tone: 'muted' });
    if (st === 'error')
      setNotice({
        text: `Nie udało się połączyć konta ${who}: ${REASON_PL[reason] ?? (reason || 'błąd')}`,
        tone: reason === 'zgoda_administratora' ? 'warn' : 'muted',
      });
    // Komunikat jednorazowy — bez parametrów w adresie po odświeżeniu strony.
    window.history.replaceState(null, '', path);
  }, []);

  const connect = async (c: ConnectionInfo, capabilities: string[]) => {
    try {
      const { url } = await api.startConnection(c.provider, capabilities);
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Błąd');
    }
  };
  const disconnect = async (c: ConnectionInfo) => {
    try {
      const r = await api.disconnect(c.provider);
      const who = PROVIDER_PL[c.provider] ?? c.provider;
      setNotice(
        r.providerRevoked === false
          ? {
              text: `Odłączono ${who} i usunięto tokeny z NovaAI, ale ${who} nie potwierdził odwołania dostępu. Usuń aplikację NovaAI także na koncie ${who}.`,
              tone: 'warn',
            }
          : {
              text:
                r.providerRevoked === true
                  ? `Odłączono ${who}: dostęp odwołany u dostawcy, tokeny usunięte z NovaAI.`
                  : `Odłączono ${who}: tokeny usunięte z NovaAI. Zgodę cofniesz na koncie ${who} (instrukcja poniżej).`,
              tone: 'muted',
            },
      );
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Błąd');
    }
  };

  return (
    <section className="panel">
      <h2 className="h-sub">Integracje</h2>
      {notice && (
        <p className={`note note-${notice.tone}`} role="status">
          {notice.text}
        </p>
      )}
      {error && <ErrorNote error={error} onRetry={load} />}
      {!items && !error && <Spinner />}
      <ul className="devices">
        {items?.map((c) => (
          <IntegrationCard
            key={c.provider}
            c={c}
            onConnect={(caps) => void connect(c, caps)}
            onDisconnect={() => void disconnect(c)}
          />
        ))}
      </ul>
    </section>
  );
}

function IntegrationCard({
  c,
  onConnect,
  onDisconnect,
}: {
  c: ConnectionInfo;
  onConnect: (capabilities: string[]) => void;
  onDisconnect: () => void;
}) {
  const conn = c.connection && c.connection.status !== 'revoked' ? c.connection : null;
  const needsReauth = conn?.status === 'error';
  const [chosen, setChosen] = useState<Set<string>>(
    () =>
      new Set(
        conn?.capabilities.length
          ? conn.capabilities
          : c.capabilities.filter((x) => !OPT_IN.has(x)),
      ),
  );
  const toggle = (cap: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(cap);
      else next.delete(cap);
      return next;
    });
  const missing = conn?.lastError?.startsWith('brak zakresów:')
    ? conn.lastError.slice('brak zakresów:'.length).trim()
    : null;
  const idBase = `int-${c.provider}`;

  return (
    <li className="device integration" aria-labelledby={`${idBase}-title`}>
      <div className="row between">
        <div>
          <strong id={`${idBase}-title`}>{c.title}</strong>
          <div className="row small">
            {!c.configured ? (
              <Badge>niedostępne</Badge>
            ) : conn?.status === 'connected' ? (
              <Badge tone="ok">połączono</Badge>
            ) : needsReauth ? (
              <Badge tone="danger">wymaga ponownego połączenia</Badge>
            ) : (
              <Badge>nie połączono</Badge>
            )}
            {conn?.account && <span className="muted">{conn.account}</span>}
          </div>
        </div>
        {c.configured && conn && (
          <button type="button" className="btn btn-ghost btn-sm danger" onClick={onDisconnect}>
            Odłącz
          </button>
        )}
      </div>

      {!c.configured && c.reason && (
        <p className="small muted">
          {c.capabilities.length
            ? `Serwer nie ma konfiguracji tej integracji: ${c.reason}.`
            : `${c.reason.charAt(0).toUpperCase()}${c.reason.slice(1)}.`}
        </p>
      )}
      {c.configured && !conn && (
        <p className="small muted">
          Konto nie jest połączone — asystent nie ma dostępu do{' '}
          {c.provider === 'slack' ? 'Twoich wiadomości na Slacku' : 'tej poczty ani kalendarza'}.
        </p>
      )}
      {needsReauth && (
        <p className="note note-danger">
          {conn?.lastError === 'revoked_by_provider'
            ? `Dostęp cofnięto po stronie ${PROVIDER_PL[c.provider] ?? c.provider} (usunięto aplikację lub odwołano token).`
            : 'Dostęp wygasł albo został cofnięty u dostawcy.'}{' '}
          Asystent nie korzysta z tego konta, dopóki nie połączysz go ponownie.
        </p>
      )}
      {conn?.status === 'connected' && (
        <ul className="cap-status" aria-label="Status uprawnień">
          {c.capabilities.map((cap) => {
            const on = conn.capabilities.includes(cap);
            return (
              <li key={cap} className={on ? 'on' : 'off'}>
                <span aria-hidden="true">{on ? '✓' : '–'}</span>
                <span>{CAP_PL[cap] ?? cap}</span>
                <span className="sr-only">{on ? 'włączone' : 'wyłączone'}</span>
                {!on && <span className="small muted">(wyłączone)</span>}
              </li>
            );
          })}
        </ul>
      )}
      {missing && <p className="note note-warn">Dostawca nie przyznał uprawnień: {missing}.</p>}

      {c.configured && (!conn || needsReauth) && c.capabilities.length > 0 && (
        <fieldset className="cap-choice">
          <legend className="small muted">Na co pozwolić asystentowi</legend>
          {c.capabilities.map((cap) => (
            <label key={cap} className="check">
              <input
                type="checkbox"
                checked={chosen.has(cap)}
                onChange={(e) => toggle(cap, e.target.checked)}
              />
              <span>
                {CAP_PL[cap] ?? cap}
                {c.permissions[cap]?.length ? (
                  <span className="perm"> {c.permissions[cap].join(', ')}</span>
                ) : null}
              </span>
            </label>
          ))}
          <div className="row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={chosen.size === 0}
              onClick={() => onConnect(c.capabilities.filter((x) => chosen.has(x)))}
            >
              {needsReauth ? 'Połącz ponownie' : 'Połącz'}
            </button>
            <span className="small muted">
              Logowanie odbywa się na stronie {PROVIDER_PL[c.provider] ?? c.provider}.
            </span>
          </div>
        </fieldset>
      )}

      {c.notes.map((n) => (
        <details key={n.title} className="conn-note">
          <summary>{n.title}</summary>
          <p>{n.text}</p>
        </details>
      ))}
      {c.revocationHelp && (conn || c.provider === 'microsoft') && (
        <details className="conn-note">
          <summary>Jak cofnąć zgodę po stronie dostawcy</summary>
          <p>{c.revocationHelp}</p>
        </details>
      )}
    </li>
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
      <label className="check">
        <input
          type="checkbox"
          checked={grant ?? false}
          disabled={grant === null}
          onChange={(e) => void api.setFreeBusyGrant(e.target.checked).then(load)}
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
