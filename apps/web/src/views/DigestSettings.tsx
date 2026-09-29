import { useEffect, useState, type FormEvent } from 'react';
import { ErrorNote } from '../components/ui';
import { api, errorText, type DigestSettings as Settings } from '../lib/api';

/**
 * Przegląd dnia wysyłany automatycznie: rano — co dziś, wieczorem — co jutro (zajęcia, przypomnienia,
 * odnowienia, pogoda). Każda osoba ustawia godziny dla siebie; miasto prognozy ustawia właściciel domu.
 */
export function DigestSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [place, setPlace] = useState('');
  const [preview, setPreview] = useState<{ title: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .digestSettings()
      .then(setS)
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  if (!s) return error ? <ErrorNote error={error} /> : null;

  const save = (next: Settings) => {
    setS(next);
    setError(null);
    api
      .saveDigestSettings(next)
      .then(() => setStatus('Zapisano.'))
      .catch((e: unknown) => setError(errorText(e)));
  };

  const savePlace = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    api
      .setWeatherPlace(place.trim())
      .then((r) => {
        setS({ ...s, weatherPlace: r.weatherPlace });
        setPlace('');
        setStatus(`Prognoza pogody dla: ${r.weatherPlace}.`);
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  const show = (kind: 'morning' | 'evening') => {
    setError(null);
    api
      .digestPreview(kind)
      .then(setPreview)
      .catch((e: unknown) => setError(errorText(e)));
  };

  return (
    <div className="digest-settings" role="group" aria-label="Przegląd dnia">
      <h3 className="h-sub small">Przegląd dnia</h3>
      {error && <ErrorNote error={error} />}
      {status && (
        <p className="small muted" role="status">
          {status}
        </p>
      )}
      <div className="digest-row">
        <label className="check">
          <input
            type="checkbox"
            checked={s.morning}
            onChange={(e) => save({ ...s, morning: e.target.checked })}
          />
          Rano — co dziś
        </label>
        <input
          type="time"
          aria-label="Godzina porannego przeglądu"
          value={s.morningAt}
          disabled={!s.morning}
          onChange={(e) => e.target.value && save({ ...s, morningAt: e.target.value })}
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => show('morning')}>
          Podgląd
        </button>
      </div>
      <div className="digest-row">
        <label className="check">
          <input
            type="checkbox"
            checked={s.evening}
            onChange={(e) => save({ ...s, evening: e.target.checked })}
          />
          Wieczorem — co jutro
        </label>
        <input
          type="time"
          aria-label="Godzina wieczornego przeglądu"
          value={s.eveningAt}
          disabled={!s.evening}
          onChange={(e) => e.target.value && save({ ...s, eveningAt: e.target.value })}
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => show('evening')}>
          Podgląd
        </button>
      </div>
      {preview && (
        <div
          className="note note-muted digest-preview"
          role="status"
          aria-label="Podgląd przeglądu"
        >
          <strong>{preview.title}</strong>
          <span className="pre">{preview.body}</span>
        </div>
      )}
      <p className="small muted">
        Pogoda: {s.weatherPlace ?? 'nie ustawiono miasta'}
        {s.weatherPlace && ` · ${s.attribution}`}
      </p>
      {s.canSetWeather && (
        <form className="row" onSubmit={savePlace} aria-label="Miasto prognozy pogody">
          <input
            placeholder="Miasto, np. Kraków"
            value={place}
            maxLength={80}
            onChange={(e) => setPlace(e.target.value)}
            aria-label="Miasto prognozy pogody"
          />
          <button type="submit" className="btn btn-sm" disabled={busy || place.trim().length < 2}>
            Ustaw
          </button>
        </form>
      )}
    </div>
  );
}
