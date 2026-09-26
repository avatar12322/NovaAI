import type {
  CostAdapterInfo,
  CostEntryInfo,
  CostKind,
  CostSummary,
  Money,
  ServiceInfo,
} from '@nova/contracts';
import { currentMonth, formatMicros, microsToText } from '@nova/contracts/money';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Badge, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { href, navigate } from '../lib/router';

/**
 * „Usługi i koszty”: rejestr usług, suma miesiąca (każda opłata liczona raz: faktura > raport dostawcy >
 * szacunek), budżety, odnowienia, wpisy kosztów i import faktur. Bez haseł i kluczy API.
 */
const CATEGORY_PL: Record<ServiceInfo['category'], string> = {
  model_api: 'Dostawca modeli (API)',
  vps: 'Serwer VPS',
  database: 'Baza danych',
  domain: 'Domena',
  backup: 'Kopie zapasowe',
  subscription: 'Abonament',
  other: 'Inne',
};
const PERIOD_PL: Record<ServiceInfo['billingPeriod'], string> = {
  monthly: 'miesięcznie',
  quarterly: 'kwartalnie',
  yearly: 'rocznie',
  one_time: 'jednorazowo',
  usage: 'za użycie',
};
const STATUS_PL: Record<ServiceInfo['status'], string> = {
  active: 'aktywna',
  trial: 'okres próbny',
  paused: 'wstrzymana',
  cancelled: 'anulowana',
};
const KIND_PL: Record<CostKind | 'invoice_unpaid', string> = {
  estimate: 'szacunek',
  report: 'raport dostawcy',
  invoice: 'faktura opłacona',
  invoice_unpaid: 'faktura do zapłaty',
};
const KIND_TONE: Record<CostKind | 'invoice_unpaid', 'neutral' | 'accent' | 'ok' | 'warn'> = {
  estimate: 'neutral',
  report: 'accent',
  invoice: 'ok',
  invoice_unpaid: 'warn',
};
const ADAPTER_STATE_PL: Record<CostAdapterInfo['state'], string> = {
  not_configured: 'niepodłączone — brak klucza administracyjnego na serwerze',
  not_connected: 'niepodłączone — synchronizacja jeszcze się nie udała',
  error: 'niepodłączone — ostatnia synchronizacja nieudana',
  connected: 'podłączone',
};

const money = (list: Money[]) =>
  list.length ? list.map((m) => formatMicros(m.micros, m.currency)).join(' + ') : '—';
/** Komunikat błędu z API; przy walidacji — konkretne powody (np. „Nie wpisuj tu haseł…”). */
const errText = (e: unknown) => {
  if (!(e instanceof ApiError)) return 'Błąd';
  const reasons = Array.isArray(e.details)
    ? [
        ...new Set(
          (e.details as Array<{ message?: unknown }>)
            .map((d) => (typeof d.message === 'string' ? d.message : null))
            .filter((m): m is string => !!m),
        ),
      ]
    : [];
  return reasons.length ? reasons.join(' ') : e.message;
};
const monthLabel = (m: string) =>
  new Date(`${m}-01T12:00:00Z`).toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' });

/** Polska odmiana: 1 usługa, 2–4 usługi, 5+ usług (12–14 usług). */
function servicesCount(n: number): string {
  const tens = n % 100;
  const units = n % 10;
  const word =
    n === 1 ? 'usługa' : units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? 'usługi' : 'usług';
  return `${n} ${word}`;
}

function daysTo(date: string): number {
  const today = new Date();
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - t) / 86_400_000);
}

function RenewalText({ s }: { s: ServiceInfo }) {
  if (!s.renewsOn) return <>—</>;
  const d = daysTo(s.renewsOn);
  const when = d === 0 ? 'dziś' : d > 0 ? `za ${d} dni` : `${-d} dni temu`;
  return (
    <>
      {new Date(`${s.renewsOn}T12:00:00Z`).toLocaleDateString('pl-PL')} ({when})
      {s.reminderScheduled && <span className="muted"> · przypomnienie ustawione</span>}
    </>
  );
}

/** Badge źródła sumy miesiąca. */
function SourceBadge({ s }: { s: ServiceInfo }) {
  const k = s.current.countedKind;
  if (!k) return <Badge>brak kosztów</Badge>;
  return <Badge tone={KIND_TONE[k]}>{k === 'invoice' ? 'faktura' : KIND_PL[k]}</Badge>;
}

function BudgetBar({ s }: { s: ServiceInfo }) {
  const b = s.current.budget;
  if (!b) return <span className="muted small">bez budżetu</span>;
  const pct = b.micros > 0 ? Math.round((b.spentMicros / b.micros) * 100) : b.spentMicros ? 999 : 0;
  const label =
    b.state === 'exceeded' ? 'przekroczony' : b.state === 'near' ? 'blisko limitu' : 'w budżecie';
  return (
    <div className={`budget-bar budget-${b.state}`}>
      <div className="row between small">
        <span>
          {formatMicros(b.spentMicros, b.currency)} z {formatMicros(b.micros, b.currency)} ({pct}%)
        </span>
        <Badge tone={b.state === 'exceeded' ? 'danger' : b.state === 'near' ? 'warn' : 'ok'}>
          {label}
        </Badge>
      </div>
      <div
        className="meter"
        role="meter"
        aria-label={`Budżet: ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(pct, 100)}
      >
        <span style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      {s.current.otherCurrencies.length > 0 && (
        <p className="small muted">
          Kwoty w {s.current.otherCurrencies.join(', ')} nie są porównywane z budżetem w{' '}
          {b.currency}.
        </p>
      )}
    </div>
  );
}

export function ServicesView({ id }: { id: string | null }) {
  const [month, setMonth] = useState(currentMonth());
  const [space, setSpace] = useState<'all' | 'private' | 'shared'>('all');
  const [items, setItems] = useState<ServiceInfo[] | null>(null);
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [adapters, setAdapters] = useState<CostAdapterInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.services(space, month), api.costSummary(space, month), api.costAdapters()])
      .then(([l, s, a]) => {
        setItems(l.items);
        setSummary(s);
        setAdapters(a.items);
        setError(null);
      })
      .catch((e: unknown) => {
        // Bez danych z poprzedniego filtra — tylko błąd i „Spróbuj ponownie”.
        setItems(null);
        setSummary(null);
        setError(errText(e));
      });
  }, [space, month]);
  useEffect(() => {
    load();
  }, [load]);

  if (id) return <ServiceDetail key={id} id={id} month={month} onChanged={load} />;

  return (
    <div className="services">
      <header className="section-head">
        <div>
          <h1>Usługi i koszty</h1>
          <p className="muted small">
            Usługi używane przez NovaAI: modele API, serwery, bazy, domeny, kopie zapasowe i
            abonamenty. Bez haseł i kluczy — tylko opis, budżet i koszty.
          </p>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(!adding)}>
          <Icon name="plus" /> Dodaj usługę
        </button>
      </header>

      <div className="row services-filters">
        <label className="row small">
          Miesiąc
          <input
            type="month"
            value={month}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
            aria-label="Miesiąc"
          />
        </label>
        <div className="space-switch" role="tablist" aria-label="Widoczność">
          {(['all', 'private', 'shared'] as const).map((sp) => (
            <button
              key={sp}
              type="button"
              role="tab"
              aria-selected={space === sp}
              className={space === sp ? 'active' : ''}
              onClick={() => setSpace(sp)}
            >
              {sp === 'all' ? 'Wszystkie' : sp === 'private' ? 'Prywatne' : 'Wspólne'}
            </button>
          ))}
        </div>
      </div>

      {adding && (
        <section className="panel">
          <h2 className="h-sub">Nowa usługa</h2>
          <ServiceForm
            onSaved={(s) => {
              setAdding(false);
              load();
              navigate({ view: 'services', id: s.id });
            }}
            onCancel={() => setAdding(false)}
          />
        </section>
      )}

      {error && <ErrorNote error={error} onRetry={load} />}
      {!items && !error && <Spinner />}
      {summary && <SummaryPanel summary={summary} />}

      {items && items.length === 0 && (
        <EmptyState title="Brak usług">
          <p>
            Dodaj pierwszą usługę — np. dostawcę modeli, serwer VPS albo domenę. Prywatne widzisz
            tylko Ty; wspólne — domownicy.
          </p>
        </EmptyState>
      )}
      {items && items.length > 0 && (
        <ul className="service-list">
          {items.map((s) => (
            <li key={s.id} className="panel service-card">
              <div className="row between">
                <a href={href({ view: 'services', id: s.id })} className="service-name">
                  {s.name}
                </a>
                <div className="row">
                  <Badge
                    tone={
                      s.status === 'active' ? 'ok' : s.status === 'cancelled' ? 'danger' : 'warn'
                    }
                  >
                    {STATUS_PL[s.status]}
                  </Badge>
                  <Badge>{s.visibility === 'shared' ? 'wspólna' : 'prywatna'}</Badge>
                </div>
              </div>
              <p className="small muted">
                {CATEGORY_PL[s.category]}
                {s.purpose ? ` · ${s.purpose}` : ''}
              </p>
              <dl className="service-facts small">
                <div>
                  <dt>Właściciel</dt>
                  <dd>{s.isMine ? 'Ty' : (s.ownerName ?? '—')}</dd>
                </div>
                <div>
                  <dt>Plan</dt>
                  <dd>{s.plan || '—'}</dd>
                </div>
                <div>
                  <dt>Rozliczenie</dt>
                  <dd>
                    {PERIOD_PL[s.billingPeriod]} · {s.currency}
                  </dd>
                </div>
                <div>
                  <dt>Odnowienie</dt>
                  <dd>
                    <RenewalText s={s} />
                  </dd>
                </div>
                <div>
                  <dt>Koszt w miesiącu</dt>
                  <dd>
                    {money(s.current.totals)} <SourceBadge s={s} />
                  </dd>
                </div>
                <div>
                  <dt>Panel</dt>
                  <dd>
                    {s.panelUrl ? (
                      <a href={s.panelUrl} target="_blank" rel="noopener noreferrer">
                        {new URL(s.panelUrl).hostname}
                      </a>
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
              </dl>
              <BudgetBar s={s} />
            </li>
          ))}
        </ul>
      )}

      <AdaptersPanel adapters={adapters} />
    </div>
  );
}

function SummaryPanel({ summary }: { summary: CostSummary }) {
  return (
    <section className="panel cost-summary" aria-label="Suma miesiąca">
      <div className="row between">
        <h2 className="h-sub">Suma: {monthLabel(summary.month)}</h2>
        <span className="small muted">{servicesCount(summary.services)}</span>
      </div>
      <p className="cost-total">{money(summary.totals)}</p>
      {summary.byKind.length > 0 && (
        <ul className="kind-list small" aria-label="Z czego">
          {summary.byKind.map((k) => (
            <li key={`${k.kind}-${k.currency}`}>
              <Badge tone={KIND_TONE[k.kind]}>{KIND_PL[k.kind]}</Badge>{' '}
              {formatMicros(k.micros, k.currency)}
            </li>
          ))}
        </ul>
      )}
      {summary.exceeded.length > 0 && (
        <p className="note note-danger" role="status">
          Przekroczony budżet: {summary.exceeded.map((e) => e.name).join(', ')}
        </p>
      )}
      <p className="small muted">
        Każda opłata liczona raz: dla usługi i miesiąca liczy się faktura, a gdy jej nie ma — raport
        dostawcy, a dopiero potem szacunek. Różnych walut nie sumujemy ani nie przeliczamy.
      </p>
    </section>
  );
}

function AdaptersPanel({ adapters }: { adapters: CostAdapterInfo[] }) {
  return (
    <section className="panel">
      <h2 className="h-sub">Raporty kosztów od dostawców</h2>
      <p className="small muted">
        Odczyt raportów kosztów organizacji kluczem administracyjnym zapisanym wyłącznie w
        konfiguracji serwera. Klucze nie są tu pokazywane ani przechowywane.
      </p>
      <ul className="devices">
        {adapters.map((a) => (
          <li key={a.id} className="device">
            <div className="row between">
              <strong>{a.title}</strong>
              <Badge
                tone={a.state === 'connected' ? 'ok' : a.state === 'error' ? 'danger' : 'neutral'}
              >
                {a.state === 'connected' ? 'podłączone' : 'niepodłączone'}
              </Badge>
            </div>
            <p className="small muted">
              {ADAPTER_STATE_PL[a.state]}
              {a.lastError ? `: ${a.lastError}` : ''}
              {a.lastSuccessAt
                ? ` · ostatnia udana synchronizacja ${new Date(a.lastSuccessAt).toLocaleString('pl-PL')}`
                : ''}
            </p>
            <p className="small muted">
              {a.serviceId ? (
                <a href={href({ view: 'services', id: a.serviceId })}>Powiązana usługa</a>
              ) : (
                'Nie przypisano do usługi (edycja usługi → „Raport kosztów”).'
              )}{' '}
              ·{' '}
              <a href={a.docsUrl} target="_blank" rel="noopener noreferrer">
                dokumentacja (sprawdzona {a.docsVerifiedAt})
              </a>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ServiceForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: ServiceInfo;
  onSaved: (s: ServiceInfo) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState(() => ({
    name: initial?.name ?? '',
    category: initial?.category ?? 'vps',
    purpose: initial?.purpose ?? '',
    panelUrl: initial?.panelUrl ?? '',
    billingPeriod: initial?.billingPeriod ?? 'monthly',
    currency: initial?.currency ?? 'PLN',
    plan: initial?.plan ?? '',
    renewsOn: initial?.renewsOn ?? '',
    remindDaysBefore: String(initial?.remindDaysBefore ?? 7),
    monthlyBudget:
      initial?.monthlyBudgetMicros != null ? microsToText(initial.monthlyBudgetMicros) : '',
    status: initial?.status ?? 'active',
    modelProvider: initial?.modelProvider ?? '',
    costAdapter: initial?.costAdapter ?? '',
    notes: initial?.notes ?? '',
    space: 'private' as 'private' | 'shared',
  }));
  const [providers, setProviders] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .modelStatus()
      .then((m) => setProviders([...new Set(m.providers.map((p) => p.kind))]))
      .catch(() => undefined);
  }, []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      name: f.name,
      category: f.category,
      purpose: f.purpose,
      panelUrl: f.panelUrl.trim() || null,
      billingPeriod: f.billingPeriod,
      currency: f.currency,
      plan: f.plan,
      renewsOn: f.renewsOn || null,
      remindDaysBefore: Number(f.remindDaysBefore) || 0,
      monthlyBudget: f.monthlyBudget.trim() || null,
      status: f.status,
      modelProvider: f.modelProvider || null,
      costAdapter: f.costAdapter || null,
      notes: f.notes,
    };
    try {
      const s = initial
        ? await api.updateService(initial.id, body)
        : await api.createService({ ...body, space: f.space });
      flash = s.warnings?.length ? s.warnings.join(' ') : null;
      onSaved(s);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="service-form" onSubmit={(e) => void submit(e)}>
      <label>
        Nazwa
        <input value={f.name} onChange={set('name')} required maxLength={120} />
      </label>
      <label>
        Rodzaj
        <select value={f.category} onChange={set('category')}>
          {Object.entries(CATEGORY_PL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="wide">
        Cel (do czego NovaAI tego używa)
        <input value={f.purpose} onChange={set('purpose')} maxLength={500} />
      </label>
      <label className="wide">
        Link do panelu (https)
        <input
          type="url"
          value={f.panelUrl}
          onChange={set('panelUrl')}
          placeholder="https://…"
          maxLength={500}
        />
      </label>
      <label>
        Okres rozliczeniowy
        <select value={f.billingPeriod} onChange={set('billingPeriod')}>
          {Object.entries(PERIOD_PL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        Waluta
        <input
          value={f.currency}
          onChange={set('currency')}
          maxLength={3}
          pattern="[A-Za-z]{3}"
          required
        />
      </label>
      <label>
        Plan
        <input value={f.plan} onChange={set('plan')} maxLength={120} />
      </label>
      <label>
        Miesięczny budżet
        <input
          value={f.monthlyBudget}
          onChange={set('monthlyBudget')}
          inputMode="decimal"
          placeholder="np. 50,00"
        />
      </label>
      <label>
        Data odnowienia
        <input type="date" value={f.renewsOn} onChange={set('renewsOn')} />
      </label>
      <label>
        Przypomnij (dni wcześniej)
        <input
          type="number"
          min={0}
          max={60}
          value={f.remindDaysBefore}
          onChange={set('remindDaysBefore')}
        />
      </label>
      <label>
        Status
        <select value={f.status} onChange={set('status')}>
          {Object.entries(STATUS_PL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        Szacunek z wywołań modeli
        <select value={f.modelProvider} onChange={set('modelProvider')}>
          <option value="">— brak —</option>
          {[...new Set([...providers, ...(f.modelProvider ? [f.modelProvider] : [])])].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label>
        Raport kosztów (adapter)
        <select value={f.costAdapter} onChange={set('costAdapter')}>
          <option value="">— brak —</option>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
      </label>
      {!initial && (
        <label>
          Widoczność
          <select value={f.space} onChange={set('space')}>
            <option value="private">prywatna (tylko Ty)</option>
            <option value="shared">wspólna (domownicy)</option>
          </select>
        </label>
      )}
      <label className="wide">
        Notatki (bez haseł i kluczy)
        <textarea value={f.notes} onChange={set('notes')} maxLength={1000} rows={2} />
      </label>
      {error && (
        <p className="note note-danger wide" role="alert">
          {error}
        </p>
      )}
      <div className="row wide">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {initial ? 'Zapisz zmiany' : 'Dodaj usługę'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Anuluj
        </button>
      </div>
    </form>
  );
}

function entryLabel(e: CostEntryInfo): CostKind | 'invoice_unpaid' {
  return e.kind === 'invoice' && !e.paidOn ? 'invoice_unpaid' : e.kind;
}

/** Komunikat do pokazania po przejściu do szczegółów (np. ostrzeżenie o przypomnieniu po utworzeniu). */
let flash: string | null = null;

function ServiceDetail({
  id,
  month,
  onChanged,
}: {
  id: string;
  month: string;
  onChanged: () => void;
}) {
  const [s, setS] = useState<(ServiceInfo & { entries: CostEntryInfo[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() => {
    const f = flash;
    flash = null;
    return f;
  });
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    api
      .service(id, month)
      .then((r) => {
        setS(r);
        setError(null);
      })
      .catch((e: unknown) => setError(errText(e)));
  }, [id, month]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<{ warnings?: string[] } | unknown>, done?: string) => {
    try {
      const r = (await fn()) as { warnings?: string[] } | undefined;
      setNotice([done, ...(r?.warnings ?? [])].filter(Boolean).join(' ') || null);
      load();
      onChanged();
    } catch (e) {
      setError(errText(e));
    }
  };

  if (error && !s)
    return (
      <div className="services">
        <a href={href({ view: 'services', id: null })} className="small">
          ← Usługi i koszty
        </a>
        <ErrorNote error={error} onRetry={load} />
      </div>
    );
  if (!s) return <Spinner />;

  return (
    <div className="services">
      <a href={href({ view: 'services', id: null })} className="small">
        ← Usługi i koszty
      </a>
      <section className="panel">
        <div className="row between">
          <h1>{s.name}</h1>
          <div className="row">
            <Badge
              tone={s.status === 'active' ? 'ok' : s.status === 'cancelled' ? 'danger' : 'warn'}
            >
              {STATUS_PL[s.status]}
            </Badge>
            <Badge>{s.visibility === 'shared' ? 'wspólna' : 'prywatna'}</Badge>
          </div>
        </div>
        <p className="muted small">
          {CATEGORY_PL[s.category]} · właściciel: {s.isMine ? 'Ty' : (s.ownerName ?? '—')}
          {s.purpose ? ` · ${s.purpose}` : ''}
        </p>
        {notice && (
          <p className="note note-muted" role="status">
            {notice}
          </p>
        )}
        {error && <ErrorNote error={error} />}
        {editing ? (
          <ServiceForm
            initial={s}
            onSaved={() => {
              setEditing(false);
              setNotice(flash ?? 'Zapisano zmiany.');
              flash = null;
              load();
              onChanged();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <dl className="service-facts small">
              <div>
                <dt>Plan</dt>
                <dd>{s.plan || '—'}</dd>
              </div>
              <div>
                <dt>Rozliczenie</dt>
                <dd>
                  {PERIOD_PL[s.billingPeriod]} · {s.currency}
                </dd>
              </div>
              <div>
                <dt>Odnowienie</dt>
                <dd>
                  <RenewalText s={s} />
                </dd>
              </div>
              <div>
                <dt>Koszt za {monthLabel(s.current.month)}</dt>
                <dd>
                  {money(s.current.totals)} <SourceBadge s={s} />
                </dd>
              </div>
              {s.current.modelEstimate.length > 0 && (
                <div>
                  <dt>Szacunek z wywołań modeli</dt>
                  <dd>{money(s.current.modelEstimate)}</dd>
                </div>
              )}
              <div>
                <dt>Panel</dt>
                <dd>
                  {s.panelUrl ? (
                    <a href={s.panelUrl} target="_blank" rel="noopener noreferrer">
                      {s.panelUrl}
                    </a>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              {s.costAdapter && (
                <div>
                  <dt>Raport kosztów</dt>
                  <dd>{s.costAdapter}</dd>
                </div>
              )}
            </dl>
            <BudgetBar s={s} />
            {s.notes && <p className="small">{s.notes}</p>}
            {s.isMine ? (
              <div className="row service-actions">
                <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                  <Icon name="edit" size={14} /> Edytuj
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    void act(
                      () => api.setServiceShared(s.id, s.visibility !== 'shared'),
                      s.visibility === 'shared'
                        ? 'Usługa jest znowu prywatna.'
                        : 'Usługa jest teraz widoczna dla domowników.',
                    )
                  }
                >
                  <Icon name="share" size={14} />{' '}
                  {s.visibility === 'shared' ? 'Cofnij udostępnienie' : 'Udostępnij domownikom'}
                </button>
                {s.renewsOn && ['monthly', 'quarterly', 'yearly'].includes(s.billingPeriod) && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      void act(() => api.serviceRenewed(s.id), 'Ustawiono następny termin.')
                    }
                  >
                    <Icon name="refresh" size={14} /> Odnowiono
                  </button>
                )}
                {s.costAdapter && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      void act(
                        () => api.syncCostAdapter(s.costAdapter!),
                        'Zsynchronizowano raport kosztów.',
                      )
                    }
                  >
                    <Icon name="download" size={14} /> Synchronizuj raport
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm danger"
                  onClick={() => {
                    if (window.confirm(`Usunąć usługę „${s.name}” wraz z wpisami kosztów?`))
                      void api
                        .deleteService(s.id)
                        .then(() => {
                          onChanged();
                          navigate({ view: 'services', id: null });
                        })
                        .catch((e: unknown) => setError(errText(e)));
                  }}
                >
                  <Icon name="trash" size={14} /> Usuń
                </button>
              </div>
            ) : (
              <p className="small muted">
                Usługa udostępniona przez {s.ownerName ?? 'domownika'} — tylko do odczytu.
              </p>
            )}
          </>
        )}
      </section>

      {s.isMine && (
        <AddCost service={s} month={month} onAdded={() => void act(async () => undefined)} />
      )}

      <section className="panel">
        <h2 className="h-sub">Wpisy kosztów</h2>
        {s.entries.length === 0 ? (
          <p className="muted small">Brak wpisów.</p>
        ) : (
          <ul className="cost-entries">
            {s.entries.map((e) => (
              <li key={e.id} className={e.counted ? '' : 'not-counted'}>
                <div className="row between">
                  <span>
                    <Badge tone={KIND_TONE[entryLabel(e)]}>{KIND_PL[entryLabel(e)]}</Badge>{' '}
                    <strong>{formatMicros(e.amountMicros, e.currency)}</strong>{' '}
                    <span className="muted small">za {monthLabel(e.month)}</span>
                  </span>
                  {s.isMine && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label="Usuń wpis"
                      onClick={() => void act(() => api.deleteCost(s.id, e.id))}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </div>
                <p className="small muted">
                  {[
                    e.invoiceNumber && `nr ${e.invoiceNumber}`,
                    e.issuedOn && `wystawiona ${e.issuedOn}`,
                    e.paidOn && `zapłacona ${e.paidOn}`,
                    e.description,
                    e.source.startsWith('adapter:')
                      ? 'z synchronizacji'
                      : e.source === 'import'
                        ? 'z importu CSV'
                        : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  {!e.counted && ' · niewliczony — w tym miesiącu liczy się dokładniejsze źródło'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AddCost({
  service,
  month,
  onAdded,
}: {
  service: ServiceInfo;
  month: string;
  onAdded: () => void;
}) {
  const [kind, setKind] = useState<CostKind>('invoice');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(service.currency);
  const [m, setM] = useState(month);
  const [number, setNumber] = useState('');
  const [issuedOn, setIssuedOn] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [description, setDescription] = useState('');
  const [csv, setCsv] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.addCost(service.id, {
        kind,
        amount,
        currency,
        month: m,
        description,
        ...(kind === 'invoice'
          ? {
              ...(number.trim() ? { invoiceNumber: number.trim() } : {}),
              ...(issuedOn ? { issuedOn } : {}),
              ...(paidOn ? { paidOn } : {}),
            }
          : {}),
      });
      setAmount('');
      setNumber('');
      setDescription('');
      setNotice('Dodano wpis.');
      onAdded();
    } catch (err) {
      setError(errText(err));
    }
  };
  const importCsv = async () => {
    setError(null);
    try {
      const r = await api.importCosts(service.id, csv);
      setNotice(`Zaimportowano ${r.created} faktur, pominięto ${r.duplicates} już zapisanych.`);
      setCsv('');
      onAdded();
    } catch (err) {
      const details = err instanceof ApiError && Array.isArray(err.details) ? err.details : [];
      setError([errText(err), ...details].join('\n'));
    }
  };

  return (
    <section className="panel">
      <h2 className="h-sub">Dodaj koszt</h2>
      <form className="service-form" onSubmit={(e) => void add(e)}>
        <label>
          Rodzaj
          <select value={kind} onChange={(e) => setKind(e.target.value as CostKind)}>
            <option value="invoice">faktura</option>
            <option value="report">raport dostawcy</option>
            <option value="estimate">szacunek</option>
          </select>
        </label>
        <label>
          Kwota
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="np. 49,99"
            required
          />
        </label>
        <label>
          Waluta
          <input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            maxLength={3}
            required
          />
        </label>
        <label>
          Za miesiąc
          <input type="month" value={m} onChange={(e) => e.target.value && setM(e.target.value)} />
        </label>
        {kind === 'invoice' && (
          <>
            <label>
              Numer faktury
              <input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={80} />
            </label>
            <label>
              Data wystawienia
              <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
            </label>
            <label>
              Data zapłaty (puste = do zapłaty)
              <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </label>
          </>
        )}
        <label className="wide">
          Opis
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={300}
          />
        </label>
        <div className="row wide">
          <button type="submit" className="btn btn-primary btn-sm">
            Dodaj
          </button>
        </div>
      </form>
      <details className="conn-note">
        <summary>Import faktur z CSV</summary>
        <p className="small muted">
          Nagłówek: <code>numer;data_wystawienia;kwota;waluta;miesiac;data_zaplaty</code> (daty
          RRRR-MM-DD, miesiąc RRRR-MM). Faktury już zapisane (ten sam numer) są pomijane.
        </p>
        <label className="sr-only" htmlFor={`csv-${service.id}`}>
          Dane CSV
        </label>
        <textarea
          id={`csv-${service.id}`}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={4}
          placeholder="numer;data_wystawienia;kwota;waluta;miesiac;data_zaplaty"
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={!csv.trim()}
          onClick={() => void importCsv()}
        >
          <Icon name="upload" size={14} /> Importuj
        </button>
      </details>
      {notice && (
        <p className="note note-muted" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="note note-danger pre" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
