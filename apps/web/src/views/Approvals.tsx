import type { Approval } from '@nova/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { Badge, EmptyState, ErrorNote, Spinner, statusTone } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useEventEffect } from '../lib/events';
import { timeAgo } from '../lib/format';
import { href } from '../lib/router';

const STATUS_PL: Record<string, string> = {
  pending: 'oczekuje',
  approved: 'zatwierdzona',
  rejected: 'odrzucona',
  expired: 'wygasła',
  invalidated: 'unieważniona',
  executing: 'w wykonaniu',
  executed: 'wykonana',
  failed: 'błąd',
};

/** Approval Center: podgląd dokładnej akcji (odbiorca, treść, zakres, ważność) i decyzja. */
export function ApprovalsView() {
  const [tab, setTab] = useState<'pending' | 'all'>('pending');
  const [items, setItems] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .approvals(tab)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Błąd'));
  }, [tab]);
  useEffect(load, [load]);
  useEventEffect((e) => e.type.startsWith('approval.'), load);

  return (
    <section className="page" aria-label="Zgody">
      <header className="section-head">
        <div>
          <h1>Zgody</h1>
          <p className="muted small">
            Zatwierdzasz dokładnie tę wersję akcji, którą widzisz. Każda zmiana wymaga nowej zgody.
          </p>
        </div>
      </header>
      <div className="space-switch" role="tablist" aria-label="Filtr zgód">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'pending'}
          className={tab === 'pending' ? 'active' : ''}
          onClick={() => setTab('pending')}
        >
          Oczekujące
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'all'}
          className={tab === 'all' ? 'active' : ''}
          onClick={() => setTab('all')}
        >
          Historia
        </button>
      </div>
      {error && <ErrorNote error={error} onRetry={load} />}
      {!items && !error && <Spinner />}
      {items?.length === 0 && (
        <EmptyState
          title={tab === 'pending' ? 'Nic nie czeka na Twoją zgodę' : 'Brak historii zgód'}
        >
          {tab === 'pending'
            ? 'Gdy asystent zaproponuje akcję wymagającą zgody — np. wiadomość do domownika albo zapis pliku — zobaczysz tu dokładną treść do zatwierdzenia.'
            : 'Tu pojawią się zatwierdzone, odrzucone i wygasłe zgody.'}
        </EmptyState>
      )}
      <div className="cards">
        {items?.map((a) => (
          <ApprovalCard key={a.id} a={a} onChange={load} />
        ))}
      </div>
    </section>
  );
}

function ApprovalCard({ a, onChange }: { a: Approval; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (kind: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'approve') await api.approve(a.id, a.actionHash);
      else await api.reject(a.id);
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Błąd');
      onChange();
    } finally {
      setBusy(false);
    }
  };
  const pending = a.status === 'pending';
  return (
    <article className="panel approval" aria-labelledby={`ap-${a.id}`}>
      <header className="approval-head">
        <Icon name="shield" />
        <h2 id={`ap-${a.id}`}>{a.summary}</h2>
        <Badge tone={statusTone(a.status)}>{STATUS_PL[a.status] ?? a.status}</Badge>
      </header>
      <dl className="kv">
        <dt>Odbiorca / zasób</dt>
        <dd>{a.target}</dd>
        <dt>Zakres</dt>
        <dd>{a.scope}</dd>
        <dt>Narzędzie</dt>
        <dd className="mono">{a.tool}</dd>
        <dt>Zadanie</dt>
        <dd>
          <a href={href({ view: 'tasks', id: a.taskId })}>{a.taskTitle}</a>
        </dd>
        <dt>{pending ? 'Wygasa' : 'Utworzona'}</dt>
        <dd>{timeAgo(pending ? a.expiresAt : a.createdAt)}</dd>
      </dl>
      {a.diff && (
        <figure className="preview">
          <figcaption className="small muted">Dokładna treść</figcaption>
          <pre>{a.diff}</pre>
        </figure>
      )}
      <p className="small muted mono" title="Skrót zamrożonej akcji">
        wersja {a.actionHash.slice(0, 12)}
      </p>
      {error && <ErrorNote error={error} />}
      {pending && (
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void act('approve')}
            disabled={busy}
          >
            <Icon name="check" /> Zatwierdź
          </button>
          <button type="button" className="btn" onClick={() => void act('reject')} disabled={busy}>
            <Icon name="x" /> Odrzuć
          </button>
        </div>
      )}
    </article>
  );
}
