import { useCallback, useEffect, useState } from 'react';
import { Badge, ErrorNote, Spinner } from '../components/ui';
import { api, errorText, type PushDevice } from '../lib/api';
import { DigestSettings } from './DigestSettings';
import {
  currentSubscription,
  disablePush,
  enablePush,
  pushPermission,
  pushSupport,
  PushSetupError,
} from '../lib/push';

/**
 * Powiadomienia na tym urządzeniu: włączenie (zgoda + subskrypcja), próbne powiadomienie, wyłączenie.
 * Każda osoba włącza je dla siebie na każdym urządzeniu osobno.
 */
export function PushPanel({ userId }: { userId: string }) {
  const support = pushSupport();
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [here, setHere] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(() => {
    void Promise.all([api.pushConfig(), api.pushDevices(), currentSubscription().catch(() => null)])
      .then(([cfg, list, sub]) => {
        setAvailable(cfg.available);
        setDevices(list.items);
        setHere(sub?.endpoint ?? null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  const run = (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    action()
      .then((msg) => {
        setStatus(msg);
        load();
      })
      .catch((e: unknown) => setError(e instanceof PushSetupError ? e.message : errorText(e)))
      .finally(() => setBusy(false));
  };

  const enabledHere = here !== null && (devices ?? []).some((d) => d.endpoint === here);
  const others = (devices ?? []).filter((d) => d.endpoint !== here);

  return (
    <section className="panel" aria-labelledby="push-title">
      <h2 id="push-title" className="h-sub">
        Powiadomienia
      </h2>
      <p className="small muted">
        Przypomnienia, wiadomości od domowników, przegląd dnia i sprawy czekające na Twoją zgodę —
        także gdy aplikacja jest zamknięta.
      </p>
      {error && <ErrorNote error={error} />}
      {status && (
        <p className="note note-muted" role="status">
          {status}
        </p>
      )}
      {support === 'ios-install' ? (
        <p className="note note-warn">
          Na iPhonie powiadomienia działają w aplikacji na ekranie głównym: w Safari dotknij
          „Udostępnij” → „Do ekranu początkowego”, otwórz NovaAI z ikony i wróć tutaj.
        </p>
      ) : support === 'unsupported' ? (
        <p className="note note-muted">Ta przeglądarka nie obsługuje powiadomień push.</p>
      ) : !available ? (
        <p className="note note-muted">Serwer nie ma skonfigurowanych powiadomień push.</p>
      ) : devices === null ? (
        <Spinner />
      ) : enabledHere ? (
        <div className="row between">
          <Badge tone="ok">włączone na tym urządzeniu</Badge>
          <div className="row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await api.pushTest();
                  return r.delivered
                    ? 'Wysłano próbne powiadomienie — powinno pojawić się za chwilę.'
                    : 'Nie udało się dostarczyć próbnego powiadomienia. Wyłącz i włącz powiadomienia ponownie.';
                })
              }
            >
              Wyślij próbne
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await disablePush();
                  return 'Wyłączono powiadomienia na tym urządzeniu.';
                })
              }
            >
              Wyłącz
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await enablePush(userId);
              return 'Powiadomienia włączone na tym urządzeniu.';
            })
          }
        >
          Włącz powiadomienia na tym urządzeniu
        </button>
      )}
      {others.length > 0 && (
        <p className="small muted">
          Włączone także na: {others.map((d) => d.label || 'urządzenie').join(', ')}.
        </p>
      )}
      <DigestSettings />
    </section>
  );
}

const PROMPT_KEY = 'nova-push-prompt-dismissed';

/**
 * Zachęta na ekranie Dom: urządzenie obsługuje powiadomienia (iPhone — aplikacja z ekranu głównego), a osoba
 * jeszcze nie odpowiedziała na pytanie o zgodę. Zgoda tylko po dotknięciu przycisku (wymóg Safari).
 */
export function PushPrompt({ userId }: { userId: string }) {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(PROMPT_KEY) === '1';
    } catch {
      /* storage niedostępny */
    }
    if (dismissed || pushSupport() !== 'ok' || pushPermission() !== 'default') return;
    let alive = true;
    api
      .pushConfig()
      .then((cfg) => alive && setShow(cfg.available))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!show) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(PROMPT_KEY, '1');
    } catch {
      /* storage niedostępny */
    }
    setShow(false);
  };
  return (
    <section className="panel" aria-labelledby="push-prompt-title">
      <h2 id="push-prompt-title" className="h-sub">
        Powiadomienia na tym urządzeniu
      </h2>
      <p className="small muted">
        Przypomnienia, przegląd dnia i wiadomości od domowników — także gdy aplikacja jest
        zamknięta.
      </p>
      {error && <ErrorNote error={error} />}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            enablePush(userId)
              .then(() => setShow(false))
              .catch((e: unknown) =>
                setError(e instanceof PushSetupError ? e.message : errorText(e)),
              )
              .finally(() => setBusy(false));
          }}
        >
          Włącz powiadomienia
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={dismiss}>
          Nie teraz
        </button>
      </div>
    </section>
  );
}
