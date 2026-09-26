import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, EmptyState, ErrorNote } from '../components/ui';
import { api, ApiError, type Reminder } from '../lib/api';
import { useEventEffect } from '../lib/events';

const toLocalInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const fmt = (iso: string) =>
  new Date(iso).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });

/** Przypomnienia: prywatne (tylko Ty) i wspólne (domownicy). Deterministyczne — bez modelu i kosztów. */
export function RemindersPanel() {
  const [mine, setMine] = useState<Reminder[]>([]);
  const [shared, setShared] = useState<Reminder[]>([]);
  const [text, setText] = useState('');
  const [due, setDue] = useState(() => toLocalInput(new Date(Date.now() + 3600_000)));
  const [space, setSpace] = useState<'private' | 'shared'>('private');
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(() => {
    Promise.all([api.reminders('private'), api.reminders('shared')])
      .then(([a, b]) => {
        setMine(a.items);
        setShared(b.items);
        setError(null);
        setLoaded(true);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Błąd'));
  }, []);
  useEffect(load, [load]);
  useEventEffect(
    (e) =>
      e.type === 'notification.created' ||
      (e.type === 'task.status' && e.payload.title === 'Przypomnienie'),
    load,
  );

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.addReminder({ text: text.trim(), dueAt: new Date(due).toISOString(), space });
      setText('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Błąd');
    }
  };

  const row = (r: Reminder) => (
    <li key={r.id} className="row between">
      <span>
        <span className="mono small">{fmt(r.dueAt)}</span> {r.text}{' '}
        {r.status === 'fired' && <Badge tone="ok">dostarczone</Badge>}
        {r.visibility === 'shared' ? (
          <Badge tone="accent">{r.isMine ? 'dla domowników' : `od: ${r.ownerName}`}</Badge>
        ) : (
          <Badge>tylko dla mnie</Badge>
        )}
      </span>
      {r.isMine && r.status === 'scheduled' && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void api.cancelReminder(r.id).then(load)}
        >
          Anuluj
        </button>
      )}
    </li>
  );

  return (
    <div>
      <h2 className="h-sub">Przypomnienia</h2>
      {error && <ErrorNote error={error} onRetry={load} />}
      <form className="grant-form reminder-form" onSubmit={(e) => void add(e)}>
        <label htmlFor="rem-text" className="sr-only">
          Treść przypomnienia
        </label>
        <input
          id="rem-text"
          placeholder="O czym przypomnieć?"
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          required
        />
        <label htmlFor="rem-due" className="sr-only">
          Termin
        </label>
        <input
          id="rem-due"
          type="datetime-local"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          required
        />
        <label htmlFor="rem-space" className="sr-only">
          Dla kogo
        </label>
        <select
          id="rem-space"
          value={space}
          onChange={(e) => setSpace(e.target.value as 'private' | 'shared')}
        >
          <option value="private">tylko dla mnie</option>
          <option value="shared">dla domowników</option>
        </select>
        <button type="submit" className="btn btn-sm" disabled={!text.trim()}>
          Dodaj
        </button>
      </form>
      {/* Pusty stan tylko po udanym wczytaniu — przy błędzie nie twierdzimy, że przypomnień nie ma. */}
      {loaded && !error && mine.length === 0 && shared.length === 0 && (
        <EmptyState title="Brak przypomnień">
          Dodaj powyżej albo napisz w czacie „przypomnij mi za 10 min: …”.
        </EmptyState>
      )}
      <ul className="grants">
        {[...mine, ...shared.filter((s) => !mine.some((m) => m.id === s.id))]
          .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
          .map(row)}
      </ul>
    </div>
  );
}
