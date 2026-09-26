import type { Memory, MemoryKind } from '@nova/contracts';
import { LIMITS } from '@nova/contracts/limits';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Badge, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useEventEffect } from '../lib/events';
import { timeAgo } from '../lib/format';
import { href } from '../lib/router';
import { MemoryTabs } from './Documents';

const KIND_PL: Record<MemoryKind, string> = {
  profile: 'fakt',
  episodic: 'zdarzenie',
  knowledge: 'wiedza',
};

export function MemoryView({ space }: { space: 'private' | 'shared' }) {
  const [items, setItems] = useState<Memory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .memories(space)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Błąd'));
  }, [space]);
  useEffect(load, [load]);
  useEventEffect((e) => e.type === 'memory.changed', load);

  return (
    <section className="page" aria-label="Pamięć">
      <MemoryTabs current="entries" />
      <header className="section-head">
        <div>
          <h1>Pamięć</h1>
          <p className="muted small">
            {space === 'private'
              ? 'Prywatne — widzisz tylko Ty i Twój asystent. Udostępnienie jest jawne i można je cofnąć.'
              : 'Wspólne — jawnie udostępnione domownikom i NovaAI.'}
          </p>
        </div>
      </header>
      <div className="space-switch" role="tablist" aria-label="Przestrzeń pamięci">
        <a
          role="tab"
          aria-selected={space === 'private'}
          className={space === 'private' ? 'active' : ''}
          href={href({ view: 'memory', space: 'private' })}
        >
          Prywatne
        </a>
        <a
          role="tab"
          aria-selected={space === 'shared'}
          className={space === 'shared' ? 'active' : ''}
          href={href({ view: 'memory', space: 'shared' })}
        >
          Wspólne
        </a>
      </div>
      <AddMemory space={space} onAdded={load} />
      {error && <ErrorNote error={error} onRetry={load} />}
      {!items && !error && <Spinner />}
      {items?.length === 0 && (
        <EmptyState
          title={space === 'private' ? 'Brak prywatnych wpisów' : 'Nic nie zostało udostępnione'}
        >
          {space === 'private'
            ? 'Dodaj fakt powyżej albo napisz w czacie „zapamiętaj: …”.'
            : 'Udostępnij wpis z listy prywatnej przyciskiem „Udostępnij”.'}
        </EmptyState>
      )}
      <ul className="memories">
        {items?.map((m) => (
          <MemoryItem key={m.id} m={m} onChange={load} />
        ))}
      </ul>
    </section>
  );
}

function AddMemory({ space, onAdded }: { space: 'private' | 'shared'; onAdded: () => void }) {
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('profile');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createMemory(content.trim(), kind, space);
      setContent('');
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Błąd');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="add-memory" onSubmit={(e) => void submit(e)}>
      <label htmlFor="mem-content" className="sr-only">
        Nowy wpis pamięci
      </label>
      <input
        id="mem-content"
        value={content}
        maxLength={LIMITS.memoryChars}
        onChange={(e) => setContent(e.target.value)}
        placeholder={
          space === 'shared'
            ? 'Dodaj wpis wspólny (od razu widoczny dla domowników)…'
            : 'Dodaj prywatny fakt…'
        }
      />
      <label htmlFor="mem-kind" className="sr-only">
        Rodzaj
      </label>
      <select id="mem-kind" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
        <option value="profile">fakt</option>
        <option value="episodic">zdarzenie</option>
        <option value="knowledge">wiedza</option>
      </select>
      <button type="submit" className="btn btn-primary" disabled={busy || !content.trim()}>
        Dodaj
      </button>
      {error && <ErrorNote error={error} />}
    </form>
  );
}

function MemoryItem({ m, onChange }: { m: Memory; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Błąd');
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="memory panel">
      {editing ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.updateMemory(m.id, text.trim());
              setEditing(false);
            });
          }}
        >
          <label htmlFor={`edit-${m.id}`} className="sr-only">
            Treść wpisu
          </label>
          <input
            id={`edit-${m.id}`}
            value={text}
            maxLength={LIMITS.memoryChars}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>
            Zapisz
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
            Anuluj
          </button>
        </form>
      ) : (
        <p className="memory-content">{m.content}</p>
      )}
      <div className="memory-meta">
        <Badge>{KIND_PL[m.kind]}</Badge>
        {m.visibility === 'shared' ? <Badge tone="accent">wspólne</Badge> : <Badge>prywatne</Badge>}
        {!m.isMine && <span className="small muted">od: {m.ownerName}</span>}
        <span className="small muted">{timeAgo(m.updatedAt)}</span>
        {m.isMine && !editing && (
          <span className="memory-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setEditing(true)}
              disabled={busy}
            >
              <Icon name="edit" /> Popraw
            </button>
            {m.visibility === 'private' ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void run(() => api.shareMemory(m.id))}
                disabled={busy}
              >
                <Icon name="share" /> Udostępnij
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void run(() => api.unshareMemory(m.id))}
                disabled={busy}
              >
                <Icon name="lock" /> Cofnij udostępnienie
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm danger"
              onClick={() => {
                if (window.confirm('Usunąć ten wpis na stałe?'))
                  void run(() => api.deleteMemory(m.id));
              }}
              disabled={busy}
            >
              <Icon name="trash" /> Usuń
            </button>
          </span>
        )}
      </div>
      {error && <ErrorNote error={error} />}
    </li>
  );
}
