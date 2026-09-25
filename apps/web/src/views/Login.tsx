import type { DevUser } from '@nova/contracts';
import { useEffect, useState } from 'react';
import { ErrorNote, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';

/**
 * Logowanie. W dev/test: wybór jednego z dwóch SZTUCZNYCH kont. Poza dev serwer nie udostępnia
 * tej trasy — ekran pokazuje wtedy uczciwie, że logowanie passkey nie jest jeszcze wdrożone.
 */
export function LoginView({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [users, setUsers] = useState<DevUser[] | null>(null);
  const [notice, setNotice] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .devUsers()
      .then((r) => {
        setUsers(r.users);
        setNotice(r.notice);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) setUnavailable(true);
        else setError(e instanceof ApiError ? e.message : 'Błąd serwera');
      });
  }, []);

  const login = async (key: string) => {
    setBusy(key);
    setError(null);
    try {
      await api.devLogin(key);
      onLoggedIn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Nie udało się zalogować');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="center-screen">
      <div className="panel narrow login">
        <div className="brand login-brand">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <h1>NovaAI</h1>
        </div>
        {error && <ErrorNote error={error} />}
        {unavailable && (
          <p className="note note-muted">
            Logowanie kluczem dostępu (passkey) nie jest jeszcze dostępne w tej wersji. Logowanie
            testowe jest wyłączone poza środowiskiem deweloperskim.
          </p>
        )}
        {!users && !unavailable && !error && <Spinner />}
        {users && (
          <>
            <p className="note note-warn">{notice}</p>
            <h2 className="h-sub">Wybierz konto testowe</h2>
            <div className="login-users">
              {users.map((u) => (
                <button
                  key={u.key}
                  type="button"
                  className="btn btn-block"
                  disabled={busy !== null}
                  onClick={() => void login(u.key)}
                >
                  <span className="avatar" aria-hidden="true">
                    {u.displayName.slice(0, 1)}
                  </span>
                  <span className="login-user">
                    <strong>{u.displayName}</strong>
                    <span className="muted small">{u.email}</span>
                  </span>
                  {busy === u.key && <Spinner label="Logowanie" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
