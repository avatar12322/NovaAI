import type { MeResponse, Notification, Task } from '@nova/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Badge, EmptyState, ErrorNote, Spinner, statusTone } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useEventEffect } from '../lib/events';
import { TASK_STATUS_PL, timeAgo } from '../lib/format';
import { href } from '../lib/router';
import { RemindersPanel } from './Reminders';

/** Dom: domownicy, wiadomości od domowników, wspólne zadania. */
export function HomeView({ me }: { me: MeResponse }) {
  const [notes, setNotes] = useState<Notification[] | null>(null);
  const [shared, setShared] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    Promise.all([api.notifications(), api.tasks('shared', 'active')])
      .then(([n, t]) => {
        setNotes(n.items);
        setShared(t.items);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Błąd'));
  }, []);
  useEffect(load, [load]);
  useEventEffect(
    (e) =>
      e.type === 'notification.created' || (e.visibility === 'shared' && e.type === 'task.status'),
    load,
  );

  return (
    <section className="page" aria-label="Dom">
      <header className="section-head">
        <div>
          <h1>{me.household?.name ?? 'Dom'}</h1>
          <p className="muted small">
            Domownicy: {me.household?.members.map((m) => m.displayName).join(', ') ?? '—'}
          </p>
        </div>
        <a className="btn btn-sm" href={href({ view: 'chat', space: 'shared', id: null })}>
          Otwórz NovaAI
        </a>
      </header>
      {error && <ErrorNote error={error} onRetry={load} />}
      <RemindersPanel />
      <div className="grid-2">
        <div>
          <h2 className="h-sub">Wiadomości</h2>
          {!notes && !error && <Spinner />}
          {notes?.length === 0 && <EmptyState title="Brak wiadomości" />}
          <ul className="list">
            {notes?.map((n) => (
              <li key={n.id} className={`panel notification ${n.readAt ? '' : 'unread'}`}>
                <div className="row between">
                  <strong>{n.title}</strong>
                  <span className="small muted">{timeAgo(n.createdAt)}</span>
                </div>
                <p>{n.body}</p>
                {!n.readAt && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void api.readNotification(n.id).then(load)}
                  >
                    Oznacz jako przeczytane
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="h-sub">Aktywne wspólne zadania</h2>
          {shared?.length === 0 && <EmptyState title="Brak aktywnych wspólnych zadań" />}
          <ul className="list">
            {shared?.map((t) => (
              <li key={t.id}>
                <a className="list-item" href={href({ view: 'tasks', id: t.id })}>
                  <span className="list-title">{t.title}</span>
                  <Badge tone={statusTone(t.status)}>{TASK_STATUS_PL[t.status]}</Badge>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
