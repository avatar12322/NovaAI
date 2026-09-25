import { useEffect, useState } from 'react';
import type { HealthResponse } from '@nova/contracts';

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch(() => setError('API niedostępne'));
  }, []);
  return (
    <main style={{ padding: 24 }}>
      <h1>NovaAI</h1>
      {error && <p role="alert">{error}</p>}
      {health && (
        <p>
          API: {health.status}, baza: {health.db}, środowisko: {health.env}
        </p>
      )}
    </main>
  );
}
