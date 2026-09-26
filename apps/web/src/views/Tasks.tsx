import type { MeResponse, Task } from '@nova/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Badge, EmptyState, ErrorNote, Progress, Spinner, statusTone } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useEventEffect } from '../lib/events';
import { STEP_STATUS_PL, TASK_STATUS_PL, timeAgo } from '../lib/format';
import { href } from '../lib/router';

export function TasksView({ me, taskId }: { me: MeResponse; taskId: string | null }) {
  const [space, setSpace] = useState<'private' | 'shared'>('private');
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .tasks(space)
      .then((r) => {
        setTasks(r.items);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Błąd'));
  }, [space]);
  useEffect(load, [load]);
  useEventEffect((e) => e.type === 'task.created' || e.type === 'task.status', load);

  return (
    <div className={`split ${taskId ? 'has-detail' : ''}`}>
      <section className="split-list" aria-label="Zadania">
        <header className="section-head">
          <h1>Zadania</h1>
        </header>
        <div className="space-switch" role="tablist" aria-label="Przestrzeń zadań">
          <button
            type="button"
            role="tab"
            aria-selected={space === 'private'}
            className={space === 'private' ? 'active' : ''}
            onClick={() => setSpace('private')}
          >
            Moje
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={space === 'shared'}
            className={space === 'shared' ? 'active' : ''}
            onClick={() => setSpace('shared')}
          >
            Wspólne
          </button>
        </div>
        {me.env !== 'production' && <NewDemoTask space={space} onCreated={load} />}
        {error && <ErrorNote error={error} onRetry={load} />}
        {!tasks && !error && <Spinner />}
        {tasks?.length === 0 && (
          <EmptyState title="Brak zadań">
            Zadania powstają z rozmów lub z formularza powyżej.
          </EmptyState>
        )}
        <ul className="list">
          {tasks?.map((t) => (
            <li key={t.id}>
              <a
                href={href({ view: 'tasks', id: t.id })}
                className={`list-item ${t.id === taskId ? 'active' : ''}`}
              >
                <span className="list-title">{t.title}</span>
                <span className="list-meta">
                  <Badge tone={statusTone(t.status)}>{TASK_STATUS_PL[t.status] ?? t.status}</Badge>
                  <span className="muted small">{timeAgo(t.createdAt)}</span>
                  {!t.isMine && <span className="tag">od domownika</span>}
                </span>
                {(t.status === 'running' || t.status === 'waiting_approval') && (
                  <Progress value={t.progress} label="Postęp zadania" />
                )}
              </a>
            </li>
          ))}
        </ul>
      </section>
      <section className="split-detail" aria-label="Szczegóły zadania">
        {taskId ? (
          <TaskDetail key={taskId} id={taskId} me={me} />
        ) : (
          <EmptyState title="Wybierz zadanie, aby zobaczyć kroki" />
        )}
      </section>
    </div>
  );
}

function NewDemoTask({ space, onCreated }: { space: 'private' | 'shared'; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createTask({ kind: 'demo.workflow', space, message: message.trim() });
      setMessage('');
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Błąd');
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        <Icon name="plus" /> Zadanie demonstracyjne
      </button>
    );
  }
  return (
    <form className="panel form" onSubmit={(e) => void submit(e)}>
      <p className="small muted">
        Demo pokazuje postęp, kroki równoległe i zgodę. Ostatni krok wyśle domownikowi poniższą
        wiadomość — dopiero po Twojej zgodzie.
      </p>
      <label htmlFor="demo-msg">Wiadomość do domownika</label>
      <input
        id="demo-msg"
        value={message}
        maxLength={1000}
        onChange={(e) => setMessage(e.target.value)}
        required
      />
      {error && <ErrorNote error={error} />}
      <div className="row">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !message.trim()}>
          Utwórz
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          Anuluj
        </button>
      </div>
    </form>
  );
}

function TaskDetail({ id, me }: { id: string; me: MeResponse }) {
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api
      .task(id)
      .then((t) => {
        setTask(t);
        setError(null);
      })
      .catch((e: unknown) =>
        setError(
          e instanceof ApiError
            ? e.status === 404
              ? 'Zadanie nie istnieje lub nie masz do niego dostępu.'
              : e.message
            : 'Błąd',
        ),
      );
  }, [id]);
  useEffect(load, [load]);
  useEventEffect((e) => e.taskId === id, load);

  const cancel = async () => {
    setBusy(true);
    try {
      setTask(await api.cancelTask(id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Błąd');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorNote error={error} onRetry={load} />;
  if (!task) return <Spinner />;
  const active = ['queued', 'running', 'waiting_approval'].includes(task.status);
  return (
    <div className="task-detail">
      <header className="section-head">
        <div>
          <a className="back-link" href={href({ view: 'tasks', id: null })}>
            ← Zadania
          </a>
          <h2>{task.title}</h2>
          <p className="muted small">
            <Badge tone={statusTone(task.status)}>{TASK_STATUS_PL[task.status]}</Badge> ·{' '}
            {task.visibility === 'shared' ? 'wspólne' : 'prywatne'} · utworzone{' '}
            {timeAgo(task.createdAt)}
            {task.ownerUserId !== me.user.id && ' · od domownika'}
          </p>
        </div>
        {active && task.isMine && (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => void cancel()}
            disabled={busy}
          >
            Anuluj zadanie
          </button>
        )}
      </header>
      {task.error && <p className="note note-danger">{task.error}</p>}
      <Progress value={task.progress} label="Postęp zadania" />
      <ol className="steps">
        {task.steps?.map((s) => (
          <li key={s.id} className={`step step-${s.status}`}>
            <div className="step-head">
              <span className="step-title">{s.title}</span>
              <Badge tone={statusTone(s.status)}>{STEP_STATUS_PL[s.status] ?? s.status}</Badge>
            </div>
            {s.dependsOn.length > 0 && (
              <p className="muted small">
                po kroku:{' '}
                {s.dependsOn
                  .map((k) => task.steps?.find((x) => x.key === k)?.title ?? k)
                  .join(', ')}
              </p>
            )}
            {s.status === 'running' && <Progress value={s.progress} label={`Postęp: ${s.title}`} />}
            {s.status === 'waiting_approval' && task.isMine && (
              <p className="small">
                <a href={href({ view: 'approvals' })}>Przejdź do zgody →</a>
              </p>
            )}
            {s.error && <p className="small muted">{s.error}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
