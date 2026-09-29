import type { MeResponse } from '@nova/contracts';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Badge, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { api, errorText, type ExpenseMonth, type RecurringPayment } from '../lib/api';
import { formatMoney } from '../lib/format';

/**
 * Wydatki: wspólne domu i osobiste, podsumowanie miesiąca po kategoriach, stałe płatności i raty
 * („Zapłacone” zapisuje wydatek raz w miesiącu). Paragon najszybciej: zdjęcie w czacie + „dodaj do wydatków”.
 */
type Filter = 'all' | 'shared' | 'private';

const todayIso = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};
const shiftMonth = (month: string, delta: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};
const monthLabel = (month: string) =>
  new Intl.DateTimeFormat('pl-PL', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}-01T12:00:00Z`),
  );
const dayLabel = (iso: string) =>
  new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${iso}T12:00:00Z`),
  );
/** „45,20” / „45.20” → 45.2 */
const parseAmount = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));

export function ExpensesView({ me }: { me: MeResponse }) {
  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const [filter, setFilter] = useState<Filter>('all');
  const [data, setData] = useState<ExpenseMonth | null>(null);
  const [payments, setPayments] = useState<RecurringPayment[] | null>(null);
  const [categories, setCategories] = useState<Array<{ key: string; label: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api.expenses(month, filter), api.payments()])
      .then(([e, p]) => {
        setData(e);
        setPayments(p.items);
        setError(null);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [month, filter]);
  useEffect(load, [load]);
  useEffect(() => {
    api
      .expenseCategories()
      .then((r) => setCategories(r.categories))
      .catch(() => undefined);
  }, []);

  const label = useMemo(() => new Map(categories.map((c) => [c.key, c.label])), [categories]);
  const names = new Map(me.household?.members.map((m) => [m.id, m.displayName]) ?? []);
  const run = (p: Promise<unknown>) =>
    p.then(load).catch((err: unknown) => setError(errorText(err)));

  return (
    <section className="page expenses" aria-label="Wydatki">
      <header className="section-head">
        <div>
          <h1>Wydatki</h1>
          <p className="muted small">
            Wspólne widzą wszyscy domownicy, osobiste — tylko Ty. Paragon: zrób zdjęcie w czacie i
            napisz „dodaj do wydatków wspólnych”.
          </p>
        </div>
      </header>
      {error && <ErrorNote error={error} onRetry={load} />}

      <section className="panel" aria-label="Podsumowanie miesiąca">
        <div className="row between">
          <div className="row">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Poprzedni miesiąc"
              onClick={() => setMonth((m) => shiftMonth(m, -1))}
            >
              ‹
            </button>
            <strong className="month-label">{monthLabel(month)}</strong>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Następny miesiąc"
              disabled={month >= todayIso().slice(0, 7)}
              onClick={() => setMonth((m) => shiftMonth(m, 1))}
            >
              ›
            </button>
          </div>
          <div className="space-switch" role="tablist" aria-label="Które wydatki">
            {(
              [
                ['all', 'Wszystkie'],
                ['shared', 'Wspólne'],
                ['private', 'Moje'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={filter === k}
                className={filter === k ? 'active' : ''}
                onClick={() => setFilter(k)}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        {!data ? (
          <Spinner />
        ) : (
          <>
            <p className="expense-total">
              {data.totals.length
                ? data.totals.map((t) => formatMoney(t.total, t.currency)).join(' + ')
                : formatMoney(0, 'PLN')}
            </p>
            {data.byCategory.length > 0 && (
              <ul className="category-bars" aria-label="Kategorie">
                {data.byCategory.map((c) => {
                  const max = Math.max(...data.byCategory.map((x) => x.total));
                  return (
                    <li key={`${c.category}-${c.currency}`}>
                      <span>{label.get(c.category) ?? c.category}</span>
                      <span className="bar" aria-hidden="true">
                        <span style={{ width: `${Math.max(4, (c.total / max) * 100)}%` }} />
                      </span>
                      <span className="mono">{formatMoney(c.total, c.currency)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>

      <AddExpense categories={categories} onAdded={load} onError={setError} />

      <section className="panel" aria-labelledby="expense-list-title">
        <h2 id="expense-list-title" className="h-sub">
          Pozycje
        </h2>
        {data && !data.items.length && (
          <EmptyState title="Brak wydatków w tym miesiącu">
            <p>Dodaj powyżej albo przez asystenta — także ze zdjęcia paragonu.</p>
          </EmptyState>
        )}
        <ul className="expense-list">
          {data?.items.map((e) => (
            <li key={e.id} className="expense-item">
              <span className="small muted mono">{dayLabel(e.spentOn)}</span>
              <span className="expense-desc">
                {e.description || label.get(e.category) || e.category}
                <span className="small muted">
                  {' '}
                  · {label.get(e.category) ?? e.category}
                  {!e.isMine && ` · ${names.get(e.ownerUserId) ?? 'domownik'}`}
                </span>
              </span>
              {e.visibility === 'shared' ? (
                <Badge tone="accent">wspólny</Badge>
              ) : (
                <Badge>osobisty</Badge>
              )}
              <span className="mono expense-amount">{formatMoney(e.amount, e.currency)}</span>
              {e.isMine ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Usuń wydatek: ${e.description || e.category}`}
                  onClick={() => {
                    if (window.confirm('Usunąć ten wydatek?')) void run(api.deleteExpense(e.id));
                  }}
                >
                  ×
                </button>
              ) : (
                <span className="icon-btn" aria-hidden="true" />
              )}
            </li>
          ))}
        </ul>
      </section>

      <Payments payments={payments} onChange={load} onError={setError} />
    </section>
  );
}

function AddExpense({
  categories,
  onAdded,
  onError,
}: {
  categories: Array<{ key: string; label: string }>;
  onAdded: () => void;
  onError: (e: string) => void;
}) {
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('jedzenie');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayIso);
  const [space, setSpace] = useState<'shared' | 'private'>('shared');
  const value = parseAmount(amount);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    api
      .addExpense({
        amount: value,
        category,
        description: description.trim(),
        spentOn: date,
        space,
      })
      .then(() => {
        setAmount('');
        setDescription('');
        onAdded();
      })
      .catch((err: unknown) => onError(errorText(err)));
  };
  return (
    <form className="panel expense-form" onSubmit={submit} aria-label="Dodaj wydatek">
      <h2 className="h-sub">Dodaj wydatek</h2>
      <div className="expense-fields">
        <input
          inputMode="decimal"
          placeholder="Kwota, np. 45,20"
          aria-label="Kwota"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
        <select
          aria-label="Kategoria"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          {categories.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          placeholder="Opis, np. Biedronka"
          aria-label="Opis"
          value={description}
          maxLength={200}
          onChange={(e) => setDescription(e.target.value)}
        />
        <input
          type="date"
          aria-label="Data"
          value={date}
          max={todayIso()}
          onChange={(e) => setDate(e.target.value)}
          required
        />
        <select
          aria-label="Czyj wydatek"
          value={space}
          onChange={(e) => setSpace(e.target.value as 'shared' | 'private')}
        >
          <option value="shared">wspólny (dom)</option>
          <option value="private">osobisty (tylko ja)</option>
        </select>
        <button type="submit" className="btn btn-primary" disabled={!(value > 0) || !date}>
          Dodaj
        </button>
      </div>
    </form>
  );
}

function Payments({
  payments,
  onChange,
  onError,
}: {
  payments: RecurringPayment[] | null;
  onChange: () => void;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [day, setDay] = useState('10');
  const [last, setLast] = useState('');
  const [space, setSpace] = useState<'shared' | 'private'>('private');
  const value = parseAmount(amount);
  const run = (p: Promise<unknown>) =>
    p.then(onChange).catch((err: unknown) => onError(errorText(err)));
  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(
      api
        .addPayment({
          name: name.trim(),
          amount: value,
          dayOfMonth: Number(day),
          lastMonth: last || null,
          space,
        })
        .then(() => {
          setName('');
          setAmount('');
          setLast('');
        }),
    );
  };
  return (
    <section className="panel" aria-labelledby="payments-title">
      <h2 id="payments-title" className="h-sub">
        Stałe płatności i raty
      </h2>
      <p className="small muted">
        Przypomnienie w przeglądzie dnia (wieczorem dzień wcześniej i rano w dniu płatności), dopóki
        nie oznaczysz „Zapłacone”.
      </p>
      {!payments ? (
        <Spinner />
      ) : (
        <ul className="payment-list" aria-label="Płatności w tym miesiącu">
          {payments.map((p) => (
            <li key={p.id} className="payment-item">
              <div>
                <strong>{p.name}</strong>{' '}
                <span className="mono">{formatMoney(p.amount, p.currency)}</span>
                <div className="small muted">
                  {p.dayOfMonth}. dnia miesiąca
                  {p.remaining !== null && ` · zostało: ${p.remaining}`}
                  {p.visibility === 'shared' ? ' · wspólna' : ' · osobista'}
                </div>
              </div>
              <div className="row">
                {p.paid ? (
                  <Badge tone="ok">zapłacone</Badge>
                ) : p.dueDate ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void run(api.paymentPaid(p.id))}
                  >
                    Zapłacone
                  </button>
                ) : (
                  <Badge>nie w tym miesiącu</Badge>
                )}
                {p.isMine && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Zakończyć płatność „${p.name}”? Zapłacone zostają w wydatkach.`,
                        )
                      )
                        void run(api.endPayment(p.id));
                    }}
                  >
                    Zakończ
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="expense-fields" onSubmit={add} aria-label="Dodaj płatność">
        <input
          placeholder="Nazwa, np. Rata za telefon"
          aria-label="Nazwa płatności"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          inputMode="decimal"
          placeholder="Kwota"
          aria-label="Kwota płatności"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
        <label className="small">
          Dzień miesiąca
          <input
            type="number"
            min={1}
            max={31}
            value={day}
            onChange={(e) => setDay(e.target.value)}
            aria-label="Dzień miesiąca"
          />
        </label>
        <label className="small">
          Ostatnia rata (opcjonalnie)
          <input
            type="month"
            value={last}
            onChange={(e) => setLast(e.target.value)}
            aria-label="Ostatnia rata"
          />
        </label>
        <select
          aria-label="Czyja płatność"
          value={space}
          onChange={(e) => setSpace(e.target.value as 'shared' | 'private')}
        >
          <option value="private">osobista (tylko ja)</option>
          <option value="shared">wspólna (dom)</option>
        </select>
        <button type="submit" className="btn" disabled={!name.trim() || !(value > 0)}>
          Dodaj płatność
        </button>
      </form>
    </section>
  );
}
