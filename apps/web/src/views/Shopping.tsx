import type { MeResponse } from '@nova/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ErrorNote, Spinner } from '../components/ui';
import { api, errorText, type ShoppingItem } from '../lib/api';
import { useEventEffect } from '../lib/events';

/** Ekran „Zakupy”: jedna wspólna lista domu, do odhaczania w sklepie (duże pola jak w notatkach). */
export function ShoppingView({ me }: { me: MeResponse }) {
  return (
    <section className="page shopping-page" aria-label="Zakupy">
      <header className="section-head">
        <div>
          <h1>Zakupy</h1>
          <p className="muted small">
            Napisz asystentowi, co chcesz ugotować — składniki z przepisu (aniagotuje.pl) trafią
            tutaj po Twoim zatwierdzeniu, z sumą ilości.
          </p>
        </div>
      </header>
      <ShoppingPanel me={me} />
    </section>
  );
}

/**
 * Wspólna lista zakupów domu: dodawanie (kilka pozycji po przecinku), odhaczanie w sklepie, usuwanie.
 * Zmiany domownika widać od razu (zdarzenie `shopping.changed`). Asystent też dopisuje i odhacza pozycje.
 */
export function ShoppingPanel({ me }: { me: MeResponse }) {
  const [items, setItems] = useState<ShoppingItem[] | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .shopping()
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  useEventEffect((e) => e.type === 'shopping.changed', load);

  const names = new Map(me.household?.members.map((m) => [m.id, m.displayName]) ?? []);
  const open = items?.filter((i) => !i.checked) ?? [];
  const done = items?.filter((i) => i.checked) ?? [];

  const add = (e: FormEvent) => {
    e.preventDefault();
    const list = text
      .split(/[,;\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!list.length) return;
    api
      .shoppingAdd(list)
      .then((r) => {
        setText('');
        setNote(r.skipped.length ? `Już na liście: ${r.skipped.join(', ')}` : null);
        load();
      })
      .catch((err: unknown) => setError(errorText(err)));
  };

  const toggle = (item: ShoppingItem) => {
    // Od razu na ekranie (w sklepie liczy się każda sekunda); serwer potwierdza przez odświeżenie.
    setItems(
      (cur) => cur?.map((x) => (x.id === item.id ? { ...x, checked: !x.checked } : x)) ?? null,
    );
    api.shoppingSet(item.id, { checked: !item.checked }).catch((err: unknown) => {
      setError(errorText(err));
      load();
    });
  };

  const remove = (item: ShoppingItem) => {
    setItems((cur) => cur?.filter((x) => x.id !== item.id) ?? null);
    api.shoppingRemove(item.id).catch((err: unknown) => {
      setError(errorText(err));
      load();
    });
  };

  const row = (i: ShoppingItem) => (
    <li key={i.id} className={`shopping-item${i.checked ? ' done' : ''}`}>
      <label className="check">
        <input type="checkbox" checked={i.checked} onChange={() => toggle(i)} />
        <span>{i.text}</span>
      </label>
      {i.addedBy !== me.user.id && names.get(i.addedBy) && (
        <span className="small muted">{names.get(i.addedBy)}</span>
      )}
      <button
        type="button"
        className="icon-btn"
        aria-label={`Usuń: ${i.text}`}
        onClick={() => remove(i)}
      >
        ×
      </button>
    </li>
  );

  return (
    <section className="panel shopping" aria-labelledby="shopping-title">
      <div className="row between">
        <h2 id="shopping-title" className="h-sub">
          Lista zakupów
        </h2>
        {open.length > 0 && <span className="small muted">do kupienia: {open.length}</span>}
      </div>
      {error && <ErrorNote error={error} onRetry={load} />}
      <form className="row" onSubmit={add} aria-label="Dodaj do listy zakupów">
        <input
          className="grow"
          placeholder="Dodaj, np. mleko, jajka, chleb"
          value={text}
          maxLength={400}
          onChange={(e) => setText(e.target.value)}
          aria-label="Co dodać do listy zakupów"
        />
        <button type="submit" className="btn btn-sm" disabled={!text.trim()}>
          Dodaj
        </button>
      </form>
      {note && <p className="small muted">{note}</p>}
      {!items && !error && <Spinner />}
      {items && !items.length && (
        <p className="small muted">
          Lista jest pusta. Możesz też napisać asystentowi: „dodaj mleko” albo „chcę zrobić leczo”.
        </p>
      )}
      {open.length > 0 && (
        <ul className="shopping-list" aria-label="Do kupienia">
          {open.map(row)}
        </ul>
      )}
      {done.length > 0 && (
        <>
          <ul className="shopping-list" aria-label="Kupione">
            {done.map(row)}
          </ul>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() =>
              void api
                .shoppingClearChecked()
                .then(load)
                .catch((err: unknown) => setError(errorText(err)))
            }
          >
            Usuń kupione ({done.length})
          </button>
        </>
      )}
    </section>
  );
}
