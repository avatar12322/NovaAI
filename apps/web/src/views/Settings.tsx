import type { HealthResponse, MeResponse } from '@nova/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { Badge, ErrorNote, Spinner } from '../components/ui';
import { api, ApiError, type BudgetStatus, type ModelStatus } from '../lib/api';
import { useEventEffect } from '../lib/events';
import { formatMoney } from '../lib/format';
import { DevicesPanel } from './Devices';

type Theme = 'system' | 'light' | 'dark';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('nova-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  try {
    localStorage.setItem('nova-theme', t);
  } catch {
    /* brak dostępu do storage — motyw tylko na tę sesję */
  }
}

export function SettingsView({ me, onLogout }: { me: MeResponse; onLogout: () => void }) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  return (
    <section className="page settings" aria-label="Ustawienia">
      <header className="section-head">
        <h1>Ustawienia</h1>
      </header>
      <ServiceStatus />
      <BudgetPanel />
      <DevicesPanel />
      <section className="panel">
        <h2 className="h-sub">Wygląd</h2>
        <div className="space-switch" role="radiogroup" aria-label="Motyw">
          {(['system', 'light', 'dark'] as Theme[]).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={theme === t}
              className={theme === t ? 'active' : ''}
              onClick={() => {
                setTheme(t);
                applyTheme(t);
              }}
            >
              {t === 'system' ? 'Systemowy' : t === 'light' ? 'Jasny' : 'Ciemny'}
            </button>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2 className="h-sub">Konto</h2>
        <dl className="kv">
          <dt>Użytkownik</dt>
          <dd>{me.user.displayName}</dd>
          <dt>E-mail</dt>
          <dd>{me.user.email}</dd>
          <dt>Logowanie</dt>
          <dd>{me.session.method === 'dev' ? 'konto testowe (dev)' : 'passkey'}</dd>
        </dl>
        <button type="button" className="btn" onClick={onLogout}>
          <Icon name="logout" /> Wyloguj
        </button>
      </section>
    </section>
  );
}

function ServiceStatus() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch(() => setError('API niedostępne'));
    api
      .modelStatus()
      .then(setModel)
      .catch(() => setModel(null));
  }, []);
  return (
    <section className="panel">
      <h2 className="h-sub">Stan usług</h2>
      {error && <ErrorNote error={error} />}
      {!health && !error && <Spinner />}
      {health && (
        <dl className="kv">
          <dt>API</dt>
          <dd>
            <Badge tone={health.status === 'ok' ? 'ok' : 'warn'}>{health.status}</Badge> wersja{' '}
            {health.version}
          </dd>
          <dt>Baza danych</dt>
          <dd>
            <Badge tone={health.db === 'ok' ? 'ok' : 'danger'}>{health.db}</Badge>
          </dd>
          <dt>Kolejka zadań</dt>
          <dd>
            {health.queue ? (
              <Badge tone={health.queue === 'running' ? 'ok' : 'warn'}>
                {health.queue === 'running' ? 'działa' : 'wyłączona'}
              </Badge>
            ) : (
              '—'
            )}
          </dd>
          <dt>Model</dt>
          <dd>
            {model ? (
              model.mode === 'demo' ? (
                <Badge tone="warn">tryb demo — brak skonfigurowanego dostawcy</Badge>
              ) : (
                <Badge tone="ok">skonfigurowany</Badge>
              )
            ) : (
              '—'
            )}
          </dd>
          {model?.providers.map((p) => (
            <div key={p.name} className="kv-row">
              <dt className="mono">{p.name}</dt>
              <dd>
                {p.configured ? (
                  <Badge tone="ok">dostępny</Badge>
                ) : (
                  <Badge>niedostępny: {p.reason}</Badge>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function BudgetPanel() {
  const [b, setB] = useState<BudgetStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [soft, setSoft] = useState('');
  const [hard, setHard] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api
      .budget()
      .then((x) => {
        setB(x);
        setSoft(x.softLimit?.toString() ?? '');
        setHard(x.hardLimit?.toString() ?? '');
        setError(null);
      })
      .catch((e: unknown) =>
        setError(
          e instanceof ApiError
            ? e.status === 404
              ? 'Moduł budżetu niedostępny w tej wersji API.'
              : e.message
            : 'Błąd',
        ),
      );
  }, []);
  useEffect(load, [load]);
  useEventEffect((e) => e.type.startsWith('budget.'), load);

  const save = async (paidCallsEnabled: boolean) => {
    setBusy(true);
    try {
      const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
      setB(await api.setBudget({ softLimit: num(soft), hardLimit: num(hard), paidCallsEnabled }));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Błąd');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2 className="h-sub">Koszt modeli (bieżący miesiąc)</h2>
      {error && <ErrorNote error={error} />}
      {!b && !error && <Spinner />}
      {b && (
        <>
          <p className="budget-line">
            <strong>{formatMoney(b.spent, b.currency)}</strong>
            {b.hardLimit !== null && (
              <span className="muted"> z {formatMoney(b.hardLimit, b.currency)}</span>
            )}
            {b.state === 'warning' && <Badge tone="warn">ostrzeżenie</Badge>}
            {b.state === 'blocked' && (
              <Badge tone="danger">limit osiągnięty — płatne wywołania wstrzymane</Badge>
            )}
            {!b.paidCallsEnabled && <Badge tone="warn">płatne wywołania wyłączone</Badge>}
          </p>
          {b.estimatedShare > 0 && (
            <p className="small muted">
              W tym estymacje (dostawca bez metadanych zużycia):{' '}
              {formatMoney(b.estimatedShare, b.currency)}
            </p>
          )}
          {b.byProvider.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Dostawca / model</th>
                  <th scope="col">Wywołania</th>
                  <th scope="col">Koszt</th>
                </tr>
              </thead>
              <tbody>
                {b.byProvider.map((p) => (
                  <tr key={`${p.provider}/${p.model}`}>
                    <td className="mono">
                      {p.provider}/{p.model}
                    </td>
                    <td>{p.calls}</td>
                    <td>
                      {formatMoney(p.cost, b.currency)}
                      {p.estimated && ' (est.)'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form
            className="budget-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save(b.paidCallsEnabled);
            }}
          >
            <label>
              Ostrzeżenie ({b.currency})
              <input inputMode="decimal" value={soft} onChange={(e) => setSoft(e.target.value)} />
            </label>
            <label>
              Twardy limit ({b.currency})
              <input inputMode="decimal" value={hard} onChange={(e) => setHard(e.target.value)} />
            </label>
            <button type="submit" className="btn btn-sm" disabled={busy}>
              Zapisz limity
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void save(!b.paidCallsEnabled)}
            >
              {b.paidCallsEnabled ? 'Wyłącz płatne wywołania' : 'Włącz płatne wywołania'}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
