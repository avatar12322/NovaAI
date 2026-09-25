import { useEffect, useState } from 'react';
import { ErrorNote, Spinner } from '../components/ui';
import { ApiError } from '../lib/api';

/** Urządzenia (Windows Worker). Panel pokazuje uczciwie stan modułu, jeśli API go nie udostępnia. */
export function DevicesPanel() {
  const [state, setState] = useState<'loading' | 'unavailable' | 'ready'>('loading');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/devices', { credentials: 'same-origin' })
      .then((r) => {
        if (r.status === 404) setState('unavailable');
        else if (r.ok) setState('ready');
        else throw new ApiError(r.status, 'error', `Błąd ${r.status}`);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Błąd'));
  }, []);
  return (
    <section className="panel">
      <h2 className="h-sub">Urządzenia</h2>
      {error && <ErrorNote error={error} />}
      {state === 'loading' && !error && <Spinner />}
      {state === 'unavailable' && (
        <p className="muted">
          Moduł urządzeń (Windows Worker) nie jest jeszcze dostępny w tej wersji API.
        </p>
      )}
    </section>
  );
}
