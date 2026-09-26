import { useEvents } from '../lib/events';
import {
  DOCUMENT_STATUS_PL,
  EVENT_PL,
  STEP_STATUS_PL,
  TASK_STATUS_PL,
  timeOfDay,
} from '../lib/format';
import { href } from '../lib/router';
import { Icon } from './Icon';

/** Activity Strip: ostatnie zdarzenia (bez treści — tylko typy, statusy, tytuły). */
export function ActivityStrip() {
  const { recent, connected } = useEvents();
  // Pomijamy szum: postęp i przejścia kroków „w toku/gotowe” (widoczne w szczegółach zadania).
  const items = recent
    .filter(
      (e) =>
        e.type !== 'task.progress' &&
        !(
          e.type === 'step.status' &&
          !['waiting_approval', 'failed'].includes(String(e.payload.status))
        ) &&
        !(e.type === 'message.created' && e.payload.role === 'user'),
    )
    .slice(0, 20);
  return (
    <aside className="activity" aria-label="Aktywność">
      <header className="activity-head">
        <Icon name="activity" />
        <h2>Aktywność</h2>
        <span
          className={`dot ${connected ? 'dot-ok' : 'dot-off'}`}
          title={connected ? 'Na żywo' : 'Rozłączono'}
        />
        <span className="sr-only">
          {connected ? 'Połączono na żywo' : 'Brak połączenia na żywo'}
        </span>
      </header>
      {items.length === 0 ? (
        <p className="muted small">Brak nowych zdarzeń w tej sesji.</p>
      ) : (
        <ol className="activity-list">
          {items.map((e) => {
            const status = typeof e.payload.status === 'string' ? e.payload.status : null;
            const title =
              typeof e.payload.taskTitle === 'string'
                ? e.payload.taskTitle
                : typeof e.payload.title === 'string'
                  ? e.payload.title
                  : null;
            const isDoc = e.type === 'document.updated';
            const docChange = isDoc
              ? (status ?? (typeof e.payload.visibility === 'string' ? e.payload.visibility : null))
              : null;
            const statusPl = isDoc
              ? docChange && (DOCUMENT_STATUS_PL[docChange] ?? docChange)
              : status
                ? (TASK_STATUS_PL[status] ?? STEP_STATUS_PL[status] ?? status)
                : null;
            const docLink =
              isDoc &&
              typeof e.payload.documentId === 'string' &&
              docChange !== 'deleted' &&
              docChange !== 'removed'
                ? href({ view: 'document', id: e.payload.documentId, ord: null })
                : null;
            return (
              <li key={e.id} className="activity-item">
                <span className="activity-time mono">{timeOfDay(e.createdAt)}</span>
                <span className="activity-text">
                  {docLink ? (
                    <a href={docLink}>{EVENT_PL[e.type]}</a>
                  ) : e.taskId && !isDoc ? (
                    <a href={href({ view: 'tasks', id: e.taskId })}>{EVENT_PL[e.type] ?? e.type}</a>
                  ) : (
                    (EVENT_PL[e.type] ?? e.type)
                  )}
                  {statusPl && <span className="muted"> · {statusPl}</span>}
                  {title && <span className="activity-title">{title}</span>}
                  {e.visibility === 'shared' && <span className="tag">wspólne</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
