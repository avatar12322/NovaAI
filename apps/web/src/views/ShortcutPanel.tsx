import { useCallback, useEffect, useState } from 'react';
import { Badge, ErrorNote, Spinner } from '../components/ui';
import { api, errorText, type ShortcutStatus } from '../lib/api';
import { timeAgo } from '../lib/format';

/**
 * Skrót Siri „Zapytaj Novę”: osobisty klucz (widoczny raz) i instrukcja dla aplikacji Skróty.
 * Pytania trafiają do prywatnej rozmowy „Siri”; odpowiedź Siri czyta na głos.
 */
export function ShortcutPanel() {
  const [status, setStatus] = useState<ShortcutStatus | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .shortcut()
      .then(setStatus)
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    action()
      .then(load)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  const create = () =>
    run(async () => {
      setKey((await api.shortcutCreateKey()).key);
      setCopied(false);
    });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(key ?? '');
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const local = status ? /^http:\/\/(localhost|127\.0\.0\.1)/.test(status.url) : false;

  return (
    <section className="panel shortcut-panel" aria-labelledby="shortcut-title">
      <h2 id="shortcut-title" className="h-sub">
        Skrót Siri
      </h2>
      <p className="small muted">
        Zapytaj asystenta głosem z iPhone’a: „Hej Siri, Zapytaj Novę”. Siri przeczyta odpowiedź, a
        rozmowa zapisze się w czacie „Siri”. Akcje wymagające zgody zatwierdzasz w aplikacji.
      </p>
      {error && <ErrorNote error={error} />}
      {!status && !error && <Spinner />}
      {status && (
        <>
          {key ? (
            <div className="note shortcut-key" role="status">
              <p>
                Twój klucz — widać go tylko teraz. Wklej go do skrótu (krok 3). Kto ma ten klucz,
                może pytać Twojego asystenta; w razie wątpliwości utwórz nowy.
              </p>
              <div className="row">
                <input
                  readOnly
                  value={key}
                  aria-label="Klucz skrótu"
                  onFocus={(e) => e.target.select()}
                />
                <button type="button" className="btn btn-sm" onClick={() => void copy()}>
                  {copied ? 'Skopiowano' : 'Kopiuj'}
                </button>
              </div>
            </div>
          ) : null}
          {status.enabled ? (
            <div className="row between">
              <span className="small">
                <Badge tone="ok">klucz aktywny</Badge>{' '}
                <span className="muted">
                  {status.lastUsedAt
                    ? `ostatnio użyty ${timeAgo(status.lastUsedAt)}`
                    : 'jeszcze nieużyty'}
                </span>
              </span>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm('Utworzyć nowy klucz? Obecny przestanie działać.')) create();
                  }}
                >
                  Nowy klucz
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await api.shortcutRevokeKey();
                      setKey(null);
                    })
                  }
                >
                  Wyłącz
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={create}>
              Utwórz klucz skrótu
            </button>
          )}
          {local && (
            <p className="note note-warn">
              Serwer ma adres lokalny — iPhone połączy się z nim dopiero po wdrożeniu aplikacji pod
              publicznym adresem.
            </p>
          )}
          <details className="shortcut-steps">
            <summary>Jak ustawić skrót na iPhonie</summary>
            <ol className="small">
              <li>
                Otwórz aplikację <strong>Skróty</strong>, dotknij „+” i nazwij skrót{' '}
                <strong>Zapytaj Novę</strong> — tą nazwą wywołasz go u Siri.
              </li>
              <li>
                Dodaj akcję <strong>Dyktuj tekst</strong> (Dictate Text).
              </li>
              <li>
                Dodaj akcję <strong>Pobierz zawartość URL</strong> (Get Contents of URL) z adresem{' '}
                <span className="mono">{status.url}</span>. Rozwiń ją i ustaw: Metoda{' '}
                <strong>POST</strong>; Nagłówki: <span className="mono">Authorization</span> ={' '}
                <span className="mono">Bearer</span> i po spacji Twój klucz; Treść żądania{' '}
                <strong>JSON</strong> z polem tekstowym <span className="mono">question</span> =
                „Podyktowany tekst”.
              </li>
              <li>
                Dodaj akcję <strong>Pokaż wynik</strong> (Show Result) z „Zawartością URL” — Siri
                przeczyta odpowiedź.
              </li>
              <li>Powiedz „Hej Siri, Zapytaj Novę” i zadaj pytanie.</li>
            </ol>
          </details>
        </>
      )}
    </section>
  );
}
