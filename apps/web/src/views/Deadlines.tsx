import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, ErrorNote } from '../components/ui';
import { api, errorText, type Deadline } from '../lib/api';

/**
 * Terminy: egzaminy i kolokwia, oddanie projektu albo zlecenia. Prywatne; przypomnienie w przeglądach dnia
 * (3 dni wcześniej, wieczorem dzień przed, rano w dniu). Przedmioty podpowiadane z wgranego planu zajęć.
 */
const KIND_PL: Record<Deadline['kind'], string> = {
  egzamin: 'egzamin / kolokwium',
  oddanie: 'oddanie',
  inne: 'termin',
};
const when = (d: Deadline) =>
  new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.allDay ? {} : { hour: '2-digit', minute: '2-digit' }),
  }).format(new Date(d.dueAt));
const daysLeft = (d: Deadline) => {
  const ms = new Date(d.dueAt).getTime() - Date.now();
  const days = Math.ceil(ms / 86_400_000);
  return days <= 0 ? 'dziś' : days === 1 ? 'jutro' : `za ${days} dni`;
};
const todayIso = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

export function DeadlinesPanel() {
  const [items, setItems] = useState<Deadline[] | null>(null);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [kind, setKind] = useState<Deadline['kind']>('egzamin');
  const [date, setDate] = useState('');
  const [hour, setHour] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .deadlines()
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    api
      .calendarImports()
      .then((r) =>
        setSubjects([
          ...new Set(
            r.items.flatMap((i) => i.subjects.filter((s) => !s.hidden).map((s) => s.title)),
          ),
        ]),
      )
      .catch(() => undefined);
  }, []);

  const add = (e: FormEvent) => {
    e.preventDefault();
    api
      .addDeadline({
        title: title.trim(),
        subject: subject.trim(),
        kind,
        due: hour ? `${date}T${hour}` : date,
      })
      .then(() => {
        setTitle('');
        setSubject('');
        setDate('');
        setHour('');
        load();
      })
      .catch((err: unknown) => setError(errorText(err)));
  };
  const run = (p: Promise<unknown>) =>
    p.then(load).catch((err: unknown) => setError(errorText(err)));

  const open = items?.filter((d) => !d.done) ?? [];
  return (
    <section className="panel deadlines" aria-labelledby="deadlines-title">
      <h2 id="deadlines-title" className="h-sub">
        Terminy
      </h2>
      <p className="small muted">
        Kolokwia, egzaminy, oddanie projektu lub zlecenia — przypomnę w przeglądzie dnia 3 dni
        wcześniej, dzień przed i w dniu terminu. Możesz też napisać: „kolokwium z analizy 15.10 o
        10”.
      </p>
      {error && <ErrorNote error={error} onRetry={load} />}
      {open.length > 0 && (
        <ul className="deadline-list" aria-label="Nadchodzące terminy">
          {open.map((d) => (
            <li key={d.id} className="deadline-item">
              <label className="check">
                <input
                  type="checkbox"
                  checked={false}
                  aria-label={`Zrobione: ${d.title}`}
                  onChange={() => {
                    // Od razu znika z listy; serwer potwierdza przy odświeżeniu.
                    setItems((cur) => cur?.filter((x) => x.id !== d.id) ?? null);
                    void run(api.setDeadlineDone(d.id, true));
                  }}
                />
                <span>
                  <strong>{d.title}</strong>
                  {d.subject && <span className="muted"> · {d.subject}</span>}
                  <span className="small muted block">
                    {when(d)} · {KIND_PL[d.kind]}
                  </span>
                </span>
              </label>
              <Badge tone={daysLeft(d) === 'dziś' || daysLeft(d) === 'jutro' ? 'warn' : undefined}>
                {daysLeft(d)}
              </Badge>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Usuń termin: ${d.title}`}
                onClick={() => void run(api.deleteDeadline(d.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="expense-fields" onSubmit={add} aria-label="Dodaj termin">
        <input
          placeholder="Co? np. Kolokwium"
          aria-label="Nazwa terminu"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <input
          placeholder="Przedmiot / klient (opcjonalnie)"
          aria-label="Przedmiot"
          list="deadline-subjects"
          value={subject}
          maxLength={200}
          onChange={(e) => setSubject(e.target.value)}
        />
        <datalist id="deadline-subjects">
          {subjects.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <select
          aria-label="Rodzaj terminu"
          value={kind}
          onChange={(e) => setKind(e.target.value as Deadline['kind'])}
        >
          <option value="egzamin">egzamin / kolokwium</option>
          <option value="oddanie">oddanie (projekt, zlecenie)</option>
          <option value="inne">inny termin</option>
        </select>
        <input
          type="date"
          aria-label="Data terminu"
          min={todayIso()}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
        <input
          type="time"
          aria-label="Godzina (opcjonalnie)"
          value={hour}
          onChange={(e) => setHour(e.target.value)}
        />
        <button type="submit" className="btn" disabled={!title.trim() || !date}>
          Dodaj termin
        </button>
      </form>
    </section>
  );
}
