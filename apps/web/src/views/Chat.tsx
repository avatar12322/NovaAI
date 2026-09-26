import type { Conversation, MeResponse, Message, MessageSource } from '@nova/contracts';
import { LIMITS } from '@nova/contracts/limits';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { AgentOrb, AssistantActivity, RevealText } from '../components/Assistant';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Icon } from '../components/Icon';
import { DictationButton, SpeakButton, useSpeaking } from '../components/Voice';
import { Badge, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { api, ApiError, type SlackLiveItem } from '../lib/api';
import { useEventEffect } from '../lib/events';
import { CONNECTOR_DENY_PL, formatMoney, locatorLabel, timeAgo, timeOfDay } from '../lib/format';
import { prefersReducedMotion } from '../lib/reveal';
import { href, navigate, parseRoute } from '../lib/router';

interface Props {
  me: MeResponse;
  space: 'private' | 'shared';
  conversationId: string | null;
}

export function ChatView({ me, space, conversationId }: Props) {
  const [list, setList] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(() => {
    api
      .conversations(space)
      .then((r) => {
        setList(r.items);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Błąd'));
  }, [space]);
  useEffect(loadList, [loadList]);
  useEventEffect((e) => e.type === 'message.created', loadList);

  // Desktop: automatycznie otwórz najnowszą rozmowę — tylko jeśli użytkownik nadal jest na liście tej przestrzeni
  // (bez nadpisywania nawigacji, która nastąpiła w trakcie ładowania) i bez nowego wpisu w historii.
  useEffect(() => {
    if (
      !conversationId &&
      list &&
      list.length > 0 &&
      window.matchMedia('(min-width: 900px)').matches
    ) {
      const current = parseRoute(window.location.hash);
      if (current.view === 'chat' && current.space === space && current.id === null) {
        window.location.replace(href({ view: 'chat', space, id: list[0]!.id }));
      }
    }
  }, [conversationId, list, space]);

  const create = async () => {
    try {
      const c = await api.createConversation(space);
      loadList();
      navigate({ view: 'chat', space, id: c.id });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Nie udało się utworzyć rozmowy');
    }
  };

  const agentName =
    me.agents.find((a) => a.kind === (space === 'shared' ? 'household' : 'private'))?.name ??
    'Asystent';

  return (
    <div className={`chat ${conversationId ? 'has-conv' : ''}`}>
      <section className="conv-list" aria-label="Rozmowy">
        <header className="section-head">
          <div>
            <h1>{space === 'shared' ? 'NovaAI' : 'Czat prywatny'}</h1>
            <p className="muted small">
              {space === 'shared' ? (
                <>
                  <Icon name="users" size={14} /> Wspólne — widoczne dla domowników
                </>
              ) : (
                <>
                  <Icon name="lock" size={14} /> Prywatne — tylko Ty i {agentName}
                </>
              )}
            </p>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void create()}>
            <Icon name="plus" /> Nowa
          </button>
        </header>
        <div className="space-switch" role="tablist" aria-label="Przestrzeń">
          <a
            role="tab"
            aria-selected={space === 'private'}
            className={space === 'private' ? 'active' : ''}
            href={href({ view: 'chat', space: 'private', id: null })}
          >
            Prywatne
          </a>
          <a
            role="tab"
            aria-selected={space === 'shared'}
            className={space === 'shared' ? 'active' : ''}
            href={href({ view: 'chat', space: 'shared', id: null })}
          >
            Wspólne (NovaAI)
          </a>
        </div>
        {error && <ErrorNote error={error} onRetry={loadList} />}
        {!list && !error && <Spinner />}
        {list && list.length === 0 && (
          <EmptyState title="Brak rozmów">
            <p>
              {space === 'shared'
                ? 'Rozmowę z NovaAI widzą wszyscy domownicy. Zacznij przyciskiem „Nowa”.'
                : `Tylko Ty i ${agentName}. Zacznij przyciskiem „Nowa”.`}
            </p>
          </EmptyState>
        )}
        {list && list.length > 0 && (
          <ul className="list">
            {list.map((c) => (
              <li key={c.id}>
                <a
                  href={href({ view: 'chat', space, id: c.id })}
                  className={`list-item ${c.id === conversationId ? 'active' : ''}`}
                  aria-current={c.id === conversationId ? 'true' : undefined}
                >
                  <span className="list-title">{c.title}</span>
                  <span className="muted small">{timeAgo(c.updatedAt)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
      {conversationId ? (
        <ErrorBoundary resetKey={conversationId}>
          <ConversationPane key={conversationId} id={conversationId} space={space} me={me} />
        </ErrorBoundary>
      ) : (
        <section className="conv-empty">
          <EmptyState title="Wybierz lub utwórz rozmowę">
            <p className="muted">
              {space === 'shared'
                ? 'NovaAI widzi wyłącznie jawnie udostępnione dane.'
                : 'Twój prywatny asystent nie ma dostępu do prywatnych danych drugiej osoby.'}
            </p>
          </EmptyState>
        </section>
      )}
    </div>
  );
}

function ConversationPane({
  id,
  space,
  me,
}: {
  id: string;
  space: 'private' | 'shared';
  me: MeResponse;
}) {
  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /** Zadanie tury agenta w toku — wskaźnik pracy trwa do jego zakończenia (także po narzędziach). */
  const [thinking, setThinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const speaking = useSpeaking();
  /** Wiadomości znane od otwarcia rozmowy; tylko nowsze dostają animację wejścia i odsłaniania. */
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const markFresh = useCallback((ids: string[]) => {
    const known = seen.current;
    if (!known) return;
    const added = ids.filter((x) => !known.has(x));
    added.forEach((x) => known.add(x));
    if (added.length) setFresh((f) => new Set([...f, ...added]));
  }, []);

  const load = useCallback(() => {
    Promise.all([api.conversation(id), api.messages(id)])
      .then(([c, m]) => {
        setConv(c);
        setMessages(m.items);
        if (!seen.current) seen.current = new Set(m.items.map((x) => x.id));
        else markFresh(m.items.map((x) => x.id));
        setError(null);
      })
      .catch((e: unknown) =>
        setError(
          e instanceof ApiError
            ? e.status === 404
              ? 'Rozmowa nie istnieje lub nie masz do niej dostępu.'
              : e.message
            : 'Błąd',
        ),
      );
  }, [id, markFresh]);
  useEffect(load, [load]);
  // Blok (bez zwracania wyniku): w nowszych przeglądarkach scrollIntoView zwraca Promise, a React traktuje
  // wartość zwróconą z efektu jako funkcję sprzątającą — to wywracało widok („destroy is not a function”).
  // Pierwsze wczytanie — od razu na dół; kolejne zmiany — płynnie (o ile system nie ogranicza ruchu).
  const scrolled = useRef(false);
  useEffect(() => {
    const smooth = scrolled.current && !prefersReducedMotion();
    bottom.current?.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'auto' });
    if (messages) scrolled.current = true;
  }, [messages, thinking]);

  // Odpowiedź asystenta nie kończy tury, jeśli po niej są narzędzia i odpowiedź uzupełniająca —
  // wskaźnik znika dopiero, gdy zadanie przestaje być w toku.
  useEventEffect((e) => e.type === 'message.created' && e.payload.conversationId === id, load);
  useEventEffect(
    (e) => e.type === 'task.status' && e.taskId === thinking,
    (e) => {
      if (!e) {
        // Resync po przerwie w połączeniu: sprawdź, czy tura agenta już się zakończyła.
        if (thinking) {
          api
            .task(thinking)
            .then((t) => {
              if (!['queued', 'running'].includes(t.status)) setThinking(null);
            })
            .catch(() => setThinking(null));
        }
        return;
      }
      const s = e.payload.status;
      if (s === 'failed' || s === 'cancelled' || s === 'completed' || s === 'waiting_approval') {
        setThinking(null);
        load();
      }
    },
  );

  // Zabezpieczenie na wypadek zgubionego zdarzenia SSE: odpytuj status tury co 2 s.
  useEffect(() => {
    if (!thinking) return;
    const iv = setInterval(() => {
      api
        .task(thinking)
        .then((t) => {
          if (!['queued', 'running'].includes(t.status)) {
            setThinking(null);
            load();
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(iv);
  }, [thinking, load]);

  const send = async (ev?: FormEvent) => {
    ev?.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      const r = await api.sendMessage(id, content);
      setDraft('');
      setMessages((m) => [...(m ?? []), r.message]);
      markFresh([r.message.id]);
      setThinking(r.taskId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Nie udało się wysłać');
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <section className="conversation" aria-label={conv?.title ?? 'Rozmowa'}>
      <header className="conv-head">
        <a
          className="icon-btn back"
          href={href({ view: 'chat', space, id: null })}
          aria-label="Wróć do listy rozmów"
        >
          ←
        </a>
        <AgentOrb state={thinking ? 'thinking' : speaking ? 'speaking' : 'idle'} size={30} />
        <div>
          <h2>{conv?.title ?? '…'}</h2>
          <p className="muted small">
            {conv?.agent.name} · {space === 'shared' ? 'wspólna' : 'prywatna'}
          </p>
        </div>
      </header>
      <div className="messages" aria-live="polite">
        {error && <ErrorNote error={error} onRetry={load} />}
        {!messages && !error && <Spinner />}
        {messages?.length === 0 && (
          <EmptyState title="Napisz pierwszą wiadomość">
            <p className="muted small">
              Przykłady: „zapamiętaj: …”, „co pamiętasz?”, „napisz do domownika: …”.
            </p>
          </EmptyState>
        )}
        {messages?.map((m) => (
          <MessageBubble key={m.id} m={m} me={me} fresh={fresh.has(m.id)} />
        ))}
        {thinking && (
          <AssistantActivity taskId={thinking} agentName={conv?.agent.name ?? 'Asystent'} />
        )}
        <div ref={bottom} />
      </div>
      <form className="composer" onSubmit={(e) => void send(e)}>
        <label htmlFor="composer-input" className="sr-only">
          Wiadomość
        </label>
        <textarea
          id="composer-input"
          value={draft}
          maxLength={LIMITS.messageChars}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          rows={1}
          placeholder={
            space === 'shared' ? 'Napisz do NovaAI (widoczne dla domowników)…' : 'Napisz wiadomość…'
          }
        />
        <DictationButton onText={(t) => setDraft((d) => (d ? `${d} ${t}` : t))} />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={sending || !draft.trim()}
          aria-label="Wyślij"
        >
          <Icon name="send" />
        </button>
      </form>
    </section>
  );
}

/** Etykiety wyników narzędzi w rozmowie (wiadomości `tool` — nie są wypowiedzią żadnej osoby). */
const TOOL_PL: Record<string, string> = {
  'memory.create': 'Zapis w pamięci',
  'reminder.create': 'Przypomnienie',
  'household.notify': 'Wiadomość do domownika',
  'calendar.freebusy': 'Zajętość w kalendarzach',
  'calendar.events': 'Wydarzenia z kalendarza',
  'mail.search': 'Wyszukiwanie poczty',
  'mail.read': 'Odczyt e-maila',
  'mail.send': 'Wysyłka e-maila',
  'mail.draft': 'Szkic e-maila',
  'slack.mentions': 'Wzmianki na Slacku',
  'slack.search': 'Wyszukiwanie na Slacku',
  'slack.send': 'Wiadomość na Slacku',
  'device.files.list': 'Pliki na urządzeniu',
  'device.files.read': 'Odczyt pliku z urządzenia',
  'device.files.write': 'Zapis pliku na urządzeniu',
  'device.git.status': 'git status',
  'device.git.diff': 'git diff',
};

function ToolResult({ m, fresh }: { m: Message; fresh: boolean }) {
  const tool = typeof m.meta.tool === 'string' ? m.meta.tool : '';
  const live =
    tool.startsWith('slack.') && m.meta.live && typeof m.meta.live === 'object'
      ? (m.meta.live as Record<string, unknown>)
      : null;
  return (
    <article className={`msg msg-tool${fresh ? ' msg-enter' : ''}`} aria-label="Wynik akcji">
      <header className="msg-meta">
        <Icon name="check" size={14} />
        <span>Wynik akcji: {TOOL_PL[tool] ?? tool}</span>
        <time dateTime={m.createdAt}>{timeOfDay(m.createdAt)}</time>
      </header>
      <div className="msg-body">{m.content}</div>
      {live && <SlackLive query={live} />}
    </article>
  );
}

/** Treść ze Slacka pobierana na żywo przy każdym otwarciu — nie jest zapisywana (zasady Slacka). */
function SlackLive({ query }: { query: Record<string, unknown> }) {
  const [items, setItems] = useState<SlackLiveItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => {
    setBusy(true);
    setError(null);
    api
      .slackLive(query)
      .then((r) => setItems(r.items))
      .catch((e: unknown) =>
        setError(
          e instanceof ApiError
            ? (CONNECTOR_DENY_PL[`connector:${e.code}`] ??
                (e.status === 503
                  ? 'Slack chwilowo nie odpowiada — spróbuj za chwilę.'
                  : e.message))
            : 'Błąd',
        ),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="slack-live">
      {!items && (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={load}>
          {busy ? 'Pobieranie…' : 'Pokaż na żywo'}
        </button>
      )}
      {error && (
        <p className="note note-danger" role="alert">
          {error}
        </p>
      )}
      {items && items.length === 0 && <p className="small muted">Brak wyników.</p>}
      {items && items.length > 0 && (
        <ul className="slack-items">
          {items.map((it) => (
            <li key={`${it.channelId}-${it.ts}`}>
              <div className="small muted">
                {it.channelName ? `#${it.channelName}` : it.channelId} · {it.author || it.authorId}{' '}
                · {new Date(Number(it.ts) * 1000).toLocaleString('pl-PL')}
              </div>
              <div>{it.text}</div>
              {/^https:\/\//.test(it.permalink) && (
                <a href={it.permalink} target="_blank" rel="noopener noreferrer" className="small">
                  Otwórz w Slacku
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {items && (
        <p className="small muted">Pobrane teraz ze Slacka; NovaAI nie zapisuje tej treści.</p>
      )}
    </div>
  );
}

function deniedNotes(denied: Array<{ tool: string; reason: string }>): string[] {
  const notes = new Set<string>();
  let other = 0;
  for (const d of denied) {
    const text = CONNECTOR_DENY_PL[d.reason];
    if (text) notes.add(text);
    else other++;
  }
  if (other)
    notes.add(`Odrzucono ${other} niedozwoloną akcję (poza uprawnieniami tego kontekstu).`);
  return [...notes];
}

function MessageBubble({ m, me, fresh }: { m: Message; me: MeResponse; fresh: boolean }) {
  if (m.role === 'tool') return <ToolResult m={m} fresh={fresh} />;
  const mine = m.authorUserId === me.user.id;
  const proposed =
    (m.meta.proposedTools as Array<{ tool: string; approval: boolean }> | undefined) ?? [];
  const denied = (m.meta.deniedTools as Array<{ tool: string; reason: string }> | undefined) ?? [];
  const usage = m.meta.usage as
    | {
        cost: number;
        currency?: string;
        estimated: boolean;
        inputTokens: number;
        outputTokens: number;
      }
    | null
    | undefined;
  return (
    <article
      className={`msg ${m.role === 'assistant' ? 'msg-assistant' : mine ? 'msg-mine' : 'msg-other'}${fresh ? ' msg-enter' : ''}`}
      data-fresh={fresh || undefined}
    >
      <header className="msg-meta">
        <span>
          {m.role === 'assistant'
            ? String(m.meta.agent ?? 'Asystent')
            : (m.authorName ?? 'Użytkownik')}
        </span>
        <time dateTime={m.createdAt}>{timeOfDay(m.createdAt)}</time>
        {m.meta.demo === true && <Badge tone="warn">demo</Badge>}
        {m.meta.notice === 'budget_blocked' && <Badge tone="danger">limit budżetu</Badge>}
        {m.meta.notice === 'model_unavailable' && <Badge tone="warn">model niedostępny</Badge>}
        {usage && usage.cost > 0 && (
          <span
            className="msg-cost"
            title={`${usage.inputTokens} tok. wej., ${usage.outputTokens} tok. wyj.`}
          >
            {formatMoney(usage.cost, usage.currency ?? 'PLN')}
            {usage.estimated ? ' (est.)' : ''}
          </span>
        )}
      </header>
      <div className="msg-body">
        {m.role === 'assistant' ? <RevealText text={m.content} animate={fresh} /> : m.content}
      </div>
      {m.role === 'assistant' && (
        <Sources sources={(m.meta.sources as MessageSource[] | undefined) ?? []} />
      )}
      {m.role === 'assistant' && <SpeakButton text={m.content} />}
      {proposed.some((p) => p.approval) && (
        <p className="msg-note">
          <Icon name="shield" size={14} /> Akcja czeka na Twoją zgodę —{' '}
          <a href={href({ view: 'approvals' })}>otwórz Zgody</a>
        </p>
      )}
      {deniedNotes(denied).map((text) => (
        <p key={text} className="msg-note muted">
          {text}
        </p>
      ))}
    </article>
  );
}

/**
 * Źródła odpowiedzi: dokument i strona/fragment, z odnośnikiem do treści fragmentu. Gdy odpowiedź nie
 * cytuje żadnego [Dn], pokazujemy fragmenty przekazane modelowi — z jawnym opisem, że to tylko kontekst.
 */
function Sources({ sources }: { sources: MessageSource[] }) {
  const cited = sources.filter((s) => s.cited);
  const shown = cited.length ? cited : sources;
  if (!shown.length) return null;
  return (
    <div className="sources">
      <span className="sources-label">
        {cited.length ? 'Źródła' : 'Fragmenty dokumentów w kontekście (bez cytatu)'}
      </span>
      <ul>
        {shown.map((s) => (
          <li key={s.ref}>
            <a className="source" href={href({ view: 'document', id: s.documentId, ord: s.ord })}>
              <span className="source-ref">{s.ref}</span>
              <Icon name="doc" size={14} />
              <span className="source-title">{s.title}</span>
              <span className="muted">· {locatorLabel(s)}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
