import type { Device, GrantCapability } from '@nova/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Badge, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useEventEffect } from '../lib/events';
import { timeAgo } from '../lib/format';

const CAP_PL: Record<GrantCapability, string> = {
  'device.files.read': 'odczyt plików',
  'device.files.write': 'zapis plików (zawsze ze zgodą)',
  'device.git.read': 'git status/diff',
};

/** Urządzenia (Windows Worker): parowanie kodem, granty katalogów/zdolności, odłączenie. */
export function DevicesPanel() {
  const [items, setItems] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);

  const load = useCallback(() => {
    api
      .devices()
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: unknown) =>
        setError(
          e instanceof ApiError
            ? e.status === 404
              ? 'Moduł urządzeń jest niedostępny w tej wersji API.'
              : e.message
            : 'Błąd',
        ),
      );
  }, []);
  useEffect(load, [load]);
  useEventEffect((e) => e.type === 'device.status', load);

  const pair = async () => {
    try {
      setPairing(await api.pairingCode());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Błąd');
    }
  };

  return (
    <section className="panel">
      <div className="row between">
        <h2 className="h-sub">Urządzenia</h2>
        <button type="button" className="btn btn-sm" onClick={() => void pair()}>
          <Icon name="device" /> Sparuj urządzenie
        </button>
      </div>
      {error && <ErrorNote error={error} onRetry={load} />}
      {pairing && (
        <div className="note note-muted pairing" role="status">
          <div>
            <p>
              Kod parowania: <strong className="mono pairing-code">{pairing.code}</strong> (ważny do{' '}
              {new Date(pairing.expiresAt).toLocaleTimeString('pl-PL', {
                hour: '2-digit',
                minute: '2-digit',
              })}
              )
            </p>
            <p className="small">
              Na komputerze:{' '}
              <code className="mono">
                nova-worker.exe pair --config worker.toml --code {pairing.code}
              </code>
              , potem <code className="mono">nova-worker.exe run --config worker.toml</code>.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setPairing(null)}
            aria-label="Zamknij"
          >
            <Icon name="x" />
          </button>
        </div>
      )}
      {!items && !error && <Spinner />}
      {items?.length === 0 && (
        <EmptyState title="Brak sparowanych urządzeń">
          Worker działa na Twoim komputerze i ma dostęp tylko do katalogów, które udostępnisz
          lokalnie i tutaj.
        </EmptyState>
      )}
      <ul className="devices">
        {items?.map((d) => (
          <DeviceItem key={d.id} d={d} onChange={load} />
        ))}
      </ul>
    </section>
  );
}

function DeviceItem({ d, onChange }: { d: Device; onChange: () => void }) {
  const [cap, setCap] = useState<GrantCapability>('device.files.read');
  const [root, setRoot] = useState('');
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
  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.addGrant(d.id, cap, root.trim());
      setRoot('');
    });
  };
  const active = d.status === 'active';
  return (
    <li className="device">
      <div className="row between">
        <div>
          <strong>{d.name}</strong> <span className="muted small">{d.platform}</span>
          <div className="row small">
            <span className={`dot ${d.online ? 'dot-ok' : 'dot-off'}`} aria-hidden="true" />
            {active ? (
              d.online ? (
                'online'
              ) : (
                `offline${d.lastSeenAt ? ` · widziane ${timeAgo(d.lastSeenAt)}` : ''}`
              )
            ) : (
              <Badge tone="danger">odłączone</Badge>
            )}
          </div>
        </div>
        {active && (
          <button
            type="button"
            className="btn btn-ghost btn-sm danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Odłączyć „${d.name}”? Urządzenie straci dostęp natychmiast.`))
                void run(() => api.revokeDevice(d.id));
            }}
          >
            Odłącz
          </button>
        )}
      </div>
      {d.grants.length > 0 && (
        <ul className="grants">
          {d.grants.map((g) => (
            <li key={g.id} className="row between">
              <span>
                <span className="mono small">{g.root}</span> · {CAP_PL[g.capability]}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void run(() => api.revokeGrant(d.id, g.id))}
              >
                Cofnij
              </button>
            </li>
          ))}
        </ul>
      )}
      {active && (
        <form className="grant-form" onSubmit={add}>
          <label htmlFor={`root-${d.id}`} className="sr-only">
            Katalog na urządzeniu
          </label>
          <input
            id={`root-${d.id}`}
            className="mono"
            placeholder="C:\Users\…\Projekty"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            required
          />
          <label htmlFor={`cap-${d.id}`} className="sr-only">
            Zdolność
          </label>
          <select
            id={`cap-${d.id}`}
            value={cap}
            onChange={(e) => setCap(e.target.value as GrantCapability)}
          >
            {(Object.keys(CAP_PL) as GrantCapability[]).map((c) => (
              <option key={c} value={c}>
                {CAP_PL[c]}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-sm" disabled={busy || !root.trim()}>
            Udostępnij
          </button>
        </form>
      )}
      {error && <ErrorNote error={error} />}
    </li>
  );
}
