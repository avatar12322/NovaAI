import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { ErrorNote } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { timeAgo } from '../lib/format';

const message = (e: unknown) =>
  e instanceof ApiError
    ? e.message
    : e instanceof Error && e.name === 'NotAllowedError'
      ? 'Anulowano lub przekroczono czas na potwierdzenie klucza.'
      : 'Operacja klucza dostępu nie powiodła się.';

export function PasskeyLoginButton({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await api.passkeyLoginOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await api.passkeyLoginVerify(challengeId, response);
      onLoggedIn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-users">
      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={() => void run()}
        disabled={busy}
      >
        <Icon name="lock" /> Zaloguj kluczem dostępu
      </button>
      {error && <ErrorNote error={error} />}
    </div>
  );
}

/** Rejestracja klucza z jednorazowego linku (fallback wdrożeniowy — link generuje administrator w CLI). */
export function EnrollView({ token, onDone }: { token: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await api.enrollOptions(token);
      const response = await startRegistration({ optionsJSON: options });
      await api.enrollVerify(token, challengeId, response);
      window.location.hash = '#/chat/private';
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center-screen">
      <div className="panel narrow login">
        <div className="brand login-brand">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <h1>Rejestracja klucza dostępu</h1>
        </div>
        <p className="muted">
          Ten jednorazowy link pozwala utworzyć klucz dostępu (passkey) na tym urządzeniu. Po
          rejestracji zalogujesz się bez hasła.
        </p>
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => void run()}
          disabled={busy}
        >
          <Icon name="lock" /> Utwórz klucz dostępu
        </button>
        {error && <ErrorNote error={error} />}
      </div>
    </div>
  );
}

export function PasskeysPanel() {
  const [items, setItems] = useState<
    Array<{ id: string; name: string; createdAt: string; lastUsedAt: string | null }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api
      .passkeys()
      .then((r) => setItems(r.items))
      .catch((e: unknown) => setError(message(e)));
  }, []);
  useEffect(load, [load]);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await api.passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON: options });
      await api.passkeyRegisterVerify(
        challengeId,
        response,
        navigator.platform ? `Klucz (${navigator.platform})` : undefined,
      );
      load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="row between">
        <h3 className="small muted">Klucze dostępu (passkeys)</h3>
        <button type="button" className="btn btn-sm" onClick={() => void add()} disabled={busy}>
          <Icon name="plus" /> Dodaj klucz dostępu
        </button>
      </div>
      {error && <ErrorNote error={error} />}
      {items.length === 0 && (
        <p className="small muted">Brak kluczy — dodaj, aby logować się bez konta testowego.</p>
      )}
      <ul className="grants passkeys">
        {items.map((k) => (
          <li key={k.id} className="row between">
            <span>
              {k.name} <span className="small muted">· dodany {timeAgo(k.createdAt)}</span>
              {k.lastUsedAt && (
                <span className="small muted"> · użyty {timeAgo(k.lastUsedAt)}</span>
              )}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm danger"
              onClick={() => void api.deletePasskey(k.id).then(load)}
            >
              Usuń
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
