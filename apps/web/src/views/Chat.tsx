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
import { Icon } from '../components/Icon';
import { DictationButton, SpeakButton } from '../components/Voice';
import { Badge, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useEventEffect } from '../lib/events';
import { formatMoney, locatorLabel, timeAgo, timeOfDay } from '../lib/format';
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
            <p>Zacznij nową rozmowę z {space === 'shared' ? 'NovaAI' : agentName}.</p>
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
        <ConversationPane key={conversationId} id={conversationId} space={space} me={me} />
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
  const [thinking, setThinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    Promise.all([api.conversation(id), api.messages(id)])
      .then(([c, m]) => {
        setConv(c);
        setMessages(m.items);
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
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [messages, thinking]);

  useEventEffect(
    (e) => e.type === 'message.created' && e.payload.conversationId === id,
    (e) => {
      if (e?.payload.role === 'assistant') setThinking(null);
      load();
    },
  );
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
          <MessageBubble key={m.id} m={m} me={me} />
        ))}
        {thinking && (
          <div className="msg msg-assistant thinking">
            <Spinner label="Asystent odpowiada" />{' '}
            <span className="muted">Asystent odpowiada…</span>
          </div>
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

function MessageBubble({ m, me }: { m: Message; me: MeResponse }) {
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
      className={`msg ${m.role === 'assistant' ? 'msg-assistant' : mine ? 'msg-mine' : 'msg-other'}`}
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
      <div className="msg-body">{m.content}</div>
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
      {denied.length > 0 && (
        <p className="msg-note muted">
          Odrzucono {denied.length} niedozwoloną akcję (poza uprawnieniami tego kontekstu).
        </p>
      )}
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
