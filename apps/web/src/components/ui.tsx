import type { ReactNode } from 'react';

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="note note-danger" role="alert">
      <span>{error}</span>
      {onRetry && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Spróbuj ponownie
        </button>
      )}
    </div>
  );
}

export function Progress({ value, label }: { value: number | null; label: string }) {
  const v = value ?? 0;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
    >
      <div className="progress-bar" style={{ width: `${v}%` }} />
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Spinner({ label = 'Ładowanie' }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
    </span>
  );
}

export const statusTone = (s: string): 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' =>
  s === 'completed' || s === 'executed'
    ? 'ok'
    : s === 'failed'
      ? 'danger'
      : s === 'waiting_approval' || s === 'pending'
        ? 'warn'
        : s === 'running' || s === 'queued'
          ? 'accent'
          : 'neutral';
