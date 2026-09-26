import type {
  HouseholdModelInfo,
  ModelProviderInfo,
  ModelProviderPreset,
  ModelsOverview,
} from '@nova/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Badge, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { api, errorText } from '../lib/api';

/**
 * „Modele AI i klucze API”: dostawcy (Anthropic, OpenAI, Gemini, inni zgodni z OpenAI), modele z cennikiem
 * i kursy walut. Klucz jest tylko wysyłany — serwer szyfruje go i nigdy nie odsyła (widać ostatnie 4 znaki).
 */
const KIND_PL: Record<ModelProviderInfo['kind'], string> = {
  anthropic: 'Anthropic API',
  openai_compatible: 'zgodny z OpenAI',
};

/** „1,5” → 1.5; puste → null; niepoprawne → NaN. */
const decimal = (v: string): number | null => {
  const t = v.trim().replace(/\s/g, '').replace(',', '.');
  if (!t) return null;
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN;
};
const fmt = (n: number) => n.toLocaleString('pl-PL', { maximumFractionDigits: 6 });
const today = () => new Date().toISOString().slice(0, 10);
/** Nazwa modelu w NovaAI z identyfikatora dostawcy (np. „claude-sonnet-5”). */
const keyFrom = (model: string) =>
  model
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 60);

export function ModelsView() {
  const [data, setData] = useState<ModelsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);
  const [addingModel, setAddingModel] = useState(false);
  /** Modele zwrócone przez „Sprawdź klucz” — podpowiedzi w formularzu modelu. */
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});

  const load = useCallback(() => {
    api
      .modelProviders()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        setData(null);
        setError(errorText(e));
      });
  }, []);
  useEffect(load, [load]);

  /** Każda zmiana zwraca aktualny stan całej strony. */
  const apply = (d: ModelsOverview, msg: string | null = null) => {
    setData(d);
    setStatus(msg);
    setError(null);
  };

  if (!data)
    return (
      <div className="page models">
        <header className="section-head">
          <h1>Modele AI i klucze API</h1>
        </header>
        {error ? <ErrorNote error={error} onRetry={load} /> : <Spinner />}
      </div>
    );

  const manage = data.canManage;
  return (
    <div className="page models">
      <header className="section-head">
        <div>
          <h1>Modele AI i klucze API</h1>
          <p className="muted small">
            Dodaj klucz API dostawcy, a potem model z cennikiem — asystent zacznie z niego korzystać
            od razu, bez restartu. Klucz jest szyfrowany na serwerze i nie da się go tu odczytać:
            widać tylko 4 ostatnie znaki.
          </p>
        </div>
      </header>

      <section className="panel row between" aria-label="Stan asystenta">
        <span>
          Asystent:{' '}
          {data.mode === 'configured' ? (
            <Badge tone="ok">odpowiada prawdziwy model</Badge>
          ) : (
            <Badge tone="warn">tryb demo — dodaj dostawcę i model</Badge>
          )}
        </span>
        <span className="small muted">Koszty liczone w {data.currency}</span>
      </section>

      {!manage && (
        <p className="note note-muted" role="note">
          Dostawców, klucze i modele zmienia właściciel domu — widzisz stan tylko do odczytu.
        </p>
      )}
      {manage && !data.vaultReady && (
        <p className="note note-warn" role="note">
          Serwer nie ma ustawionego <code>NOVA_SECRET_KEY</code> — klucza API nie da się bezpiecznie
          zapisać. Ustaw go w pliku <code>.env</code> i uruchom serwer ponownie.
        </p>
      )}
      {error && <ErrorNote error={error} />}
      {status && (
        <p className="note note-muted" role="status">
          {status}
        </p>
      )}

      <section className="panel">
        <div className="row between">
          <h2 className="h-sub">Dostawcy</h2>
          {manage && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setAddingProvider(!addingProvider)}
            >
              <Icon name="plus" /> Dodaj dostawcę
            </button>
          )}
        </div>
        {addingProvider && (
          <ProviderForm
            presets={data.presets}
            vaultReady={data.vaultReady}
            onSaved={(d, name) => {
              setAddingProvider(false);
              apply(d, `Dodano dostawcę ${name}. Sprawdź klucz, a potem dodaj model.`);
            }}
            onCancel={() => setAddingProvider(false)}
          />
        )}
        {data.providers.length === 0 && !addingProvider && (
          <EmptyState title="Brak dostawców">
            <p>
              {manage
                ? 'Dodaj klucz API: Anthropic (Claude), OpenAI, Google Gemini albo inny serwer zgodny z OpenAI.'
                : 'Właściciel domu nie dodał jeszcze żadnego dostawcy.'}
            </p>
          </EmptyState>
        )}
        <ul className="devices">
          {data.providers.map((p) => (
            <ProviderItem
              key={p.id}
              p={p}
              manage={manage}
              vaultReady={data.vaultReady}
              onChanged={apply}
              onError={setError}
              onModels={(ids) => setSuggestions((s) => ({ ...s, [p.id]: ids }))}
            />
          ))}
        </ul>
      </section>

      <section className="panel">
        <div className="row between">
          <h2 className="h-sub">Modele</h2>
          {manage && data.providers.length > 0 && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setAddingModel(!addingModel)}
            >
              <Icon name="plus" /> Dodaj model
            </button>
          )}
        </div>
        <p className="small muted">
          Ceny wpisz z oficjalnego cennika dostawcy (za milion tokenów). NovaAI liczy z nich koszt
          każdej odpowiedzi i pilnuje budżetu — model bez cennika nie jest używany.
        </p>
        {addingModel && (
          <ModelForm
            data={data}
            suggestions={suggestions}
            onSaved={(d) => {
              setAddingModel(false);
              apply(d, 'Dodano model.');
            }}
            onCancel={() => setAddingModel(false)}
          />
        )}
        {data.models.length === 0 && !addingModel && (
          <EmptyState title="Brak modeli">
            <p>Po dodaniu dostawcy dodaj model (np. identyfikator z listy „Sprawdź klucz”).</p>
          </EmptyState>
        )}
        <ul className="devices">
          {data.models.map((m) => (
            <ModelItem
              key={m.id}
              m={m}
              data={data}
              manage={manage}
              suggestions={suggestions}
              onChanged={apply}
              onError={setError}
            />
          ))}
        </ul>
      </section>

      <FxPanel data={data} manage={manage} onChanged={apply} onError={setError} />

      {(data.fileProviders.length > 0 || data.fileModels.length > 0) && (
        <section className="panel">
          <h2 className="h-sub">Z konfiguracji serwera</h2>
          <p className="small muted">
            Modele z pliku <code>models.local.json</code> i kluczy w zmiennych środowiskowych —
            zmienia je administrator serwera. Nazwy z pliku mają pierwszeństwo.
          </p>
          <ul className="devices">
            {data.fileModels.map((m) => (
              <li key={m.key} className="device">
                <div className="row between">
                  <span className="mono">
                    {m.key} ({m.provider}/{m.model})
                  </span>
                  {m.available ? (
                    <Badge tone="ok">dostępny</Badge>
                  ) : (
                    <Badge>niedostępny: {m.reason}</Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ProviderForm({
  presets,
  vaultReady,
  onSaved,
  onCancel,
}: {
  presets: readonly ModelProviderPreset[];
  vaultReady: boolean;
  onSaved: (d: ModelsOverview, name: string) => void;
  onCancel: () => void;
}) {
  const [presetId, setPresetId] = useState<ModelProviderPreset['id']>('anthropic');
  const preset = presets.find((p) => p.id === presetId) ?? presets[0]!;
  const [f, setF] = useState({
    label: preset.label,
    name: preset.name,
    baseUrl: preset.baseUrl ?? '',
    apiKey: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const choose = (id: ModelProviderPreset['id']) => {
    const p = presets.find((x) => x.id === id)!;
    setPresetId(id);
    setF((cur) => ({
      ...cur,
      label: p.id === 'custom' ? '' : p.label,
      name: p.name,
      baseUrl: p.baseUrl ?? '',
    }));
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await api.addModelProvider({
        name: f.name.trim(),
        label: f.label.trim(),
        kind: preset.kind,
        baseUrl: preset.kind === 'anthropic' ? null : f.baseUrl.trim() || null,
        ...(f.apiKey.trim() ? { apiKey: f.apiKey.trim() } : {}),
      });
      // Klucz nie zostaje w pamięci formularza.
      setF((cur) => ({ ...cur, apiKey: '' }));
      onSaved(d, f.label.trim());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="service-form model-form" onSubmit={(e) => void submit(e)}>
      <fieldset className="wide preset-choice">
        <legend>Dostawca</legend>
        {presets.map((p) => (
          <label key={p.id} className="check">
            <input
              type="radio"
              name="preset"
              checked={presetId === p.id}
              onChange={() => choose(p.id)}
            />
            {p.label}
          </label>
        ))}
      </fieldset>
      <p className="small muted wide">
        {preset.note}{' '}
        {preset.keysUrl && (
          <a href={preset.keysUrl} target="_blank" rel="noopener noreferrer">
            Gdzie utworzyć klucz
          </a>
        )}
      </p>
      <label>
        Nazwa wyświetlana
        <input value={f.label} onChange={set('label')} required maxLength={80} />
      </label>
      <label>
        Nazwa w NovaAI (koszty, „Usługi i koszty”)
        <input
          value={f.name}
          onChange={set('name')}
          required
          pattern="[a-z][a-z0-9_\-]{1,39}"
          title="małe litery, cyfry, - lub _"
          maxLength={40}
          className="mono"
        />
      </label>
      {preset.kind === 'openai_compatible' && (
        <label className="wide">
          Adres serwera (https://, a dla serwera lokalnego http://localhost)
          <input
            type="url"
            value={f.baseUrl}
            onChange={set('baseUrl')}
            required
            placeholder="https://…/v1"
            maxLength={300}
            className="mono"
          />
        </label>
      )}
      <label className="wide">
        Klucz API {preset.id === 'custom' && '(puste dla serwera lokalnego bez klucza)'}
        <input
          type="password"
          value={f.apiKey}
          onChange={set('apiKey')}
          autoComplete="new-password"
          spellCheck={false}
          required={preset.id !== 'custom'}
          disabled={!vaultReady}
          maxLength={400}
          className="mono"
        />
        <span className="small muted">
          Zostanie zaszyfrowany na serwerze. Nikt — także Ty — nie zobaczy go tu ponownie.
        </span>
      </label>
      {error && (
        <p className="note note-danger wide" role="alert">
          {error}
        </p>
      )}
      <div className="row wide">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          Zapisz dostawcę
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Anuluj
        </button>
      </div>
    </form>
  );
}

function ProviderItem({
  p,
  manage,
  vaultReady,
  onChanged,
  onError,
  onModels,
}: {
  p: ModelProviderInfo;
  manage: boolean;
  vaultReady: boolean;
  onChanged: (d: ModelsOverview, msg?: string | null) => void;
  onError: (e: string) => void;
  onModels: (ids: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const checkKey = () =>
    run(async () => {
      const r = await api.checkModelProvider(p.id);
      setCheck(r);
      if (r.models.length) onModels(r.models);
      onChanged(await api.modelProviders());
    });
  const saveKey = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const d = await api.updateModelProvider(p.id, { apiKey: newKey.trim() });
      setNewKey('');
      setReplacing(false);
      setCheck(null);
      onChanged(d, `Zapisano nowy klucz dla ${p.label}.`);
    });
  };
  const remove = () => {
    const extra = p.modelCount ? ` wraz z modelami (${p.modelCount})` : '';
    if (!window.confirm(`Usunąć dostawcę ${p.label}${extra}? Klucz zostanie skasowany.`)) return;
    void run(async () => onChanged(await api.deleteModelProvider(p.id), `Usunięto ${p.label}.`));
  };

  const last = check ?? p.lastCheck;
  return (
    <li className="device provider-item">
      <div className="row between">
        <strong>{p.label}</strong>
        {p.usable ? <Badge tone="ok">gotowy</Badge> : <Badge tone="warn">{p.reason}</Badge>}
      </div>
      <p className="small muted">
        <span className="mono">{p.name}</span> · {KIND_PL[p.kind]}
        {p.baseUrl ? (
          <>
            {' '}
            · <span className="mono">{p.baseUrl}</span>
          </>
        ) : null}{' '}
        · modele: {p.modelCount}
      </p>
      <p className="small">
        Klucz API:{' '}
        {p.hasKey ? (
          <span className="mono key-hint" aria-label={`zapisany, kończy się na ${p.keyHint}`}>
            •••• {p.keyHint}
          </span>
        ) : (
          <span className="muted">brak</span>
        )}
        {last && (
          <>
            {' '}
            · <Badge tone={last.ok ? 'ok' : 'danger'}>{last.ok ? 'działa' : 'błąd'}</Badge>{' '}
            <span className="muted">{last.message}</span>
          </>
        )}
      </p>
      {manage && (
        <div className="row service-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void checkKey()}
          >
            Sprawdź klucz
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || !vaultReady}
            onClick={() => setReplacing(!replacing)}
          >
            {p.hasKey ? 'Zmień klucz' : 'Dodaj klucz'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              void run(async () =>
                onChanged(await api.updateModelProvider(p.id, { enabled: !p.enabled })),
              )
            }
          >
            {p.enabled ? 'Wyłącz' : 'Włącz'}
          </button>
          <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={remove}>
            <Icon name="trash" /> Usuń
          </button>
        </div>
      )}
      {replacing && (
        <form className="row" onSubmit={saveKey}>
          <label className="grow">
            <span className="sr-only">Nowy klucz API</span>
            <input
              type="password"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              required
              maxLength={400}
              placeholder="Nowy klucz API"
              className="mono"
            />
          </label>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            Zapisz klucz
          </button>
        </form>
      )}
    </li>
  );
}

type ModelDraft = {
  providerId: string;
  model: string;
  name: string;
  nameTouched: boolean;
  currency: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  source: string;
  verifiedAt: string;
  maxTokens: string;
  useSimple: boolean;
  useComplex: boolean;
  priority: string;
  dataPolicy: 'private_ok' | 'shared_only';
};

function ModelForm({
  data,
  suggestions,
  initial,
  onSaved,
  onCancel,
}: {
  data: ModelsOverview;
  suggestions: Record<string, string[]>;
  initial?: HouseholdModelInfo;
  onSaved: (d: ModelsOverview) => void;
  onCancel: () => void;
}) {
  const presetFor = (providerId: string) => {
    const p = data.providers.find((x) => x.id === providerId);
    return data.presets.find((x) => x.name && x.name === p?.name);
  };
  const firstProvider = initial?.providerId ?? data.providers[0]?.id ?? '';
  const [f, setF] = useState<ModelDraft>(() => ({
    providerId: firstProvider,
    model: initial?.model ?? '',
    name: initial?.name ?? '',
    nameTouched: !!initial,
    currency: initial?.pricing.currency ?? 'USD',
    input: initial ? String(initial.pricing.inputPerMTok).replace('.', ',') : '',
    output: initial ? String(initial.pricing.outputPerMTok).replace('.', ',') : '',
    cacheRead: initial?.pricing.cacheReadPerMTok?.toString().replace('.', ',') ?? '',
    cacheWrite: initial?.pricing.cacheWritePerMTok?.toString().replace('.', ',') ?? '',
    source: initial?.pricing.source ?? presetFor(firstProvider)?.pricingUrl ?? '',
    verifiedAt: initial?.pricing.verifiedAt ?? today(),
    maxTokens: String(initial?.maxTokens ?? 4000),
    useSimple: initial?.useSimple ?? true,
    useComplex: initial?.useComplex ?? true,
    priority: String(initial?.priority ?? 100),
    dataPolicy: initial?.dataPolicy ?? 'private_ok',
  }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set =
    <K extends keyof ModelDraft>(k: K) =>
    (e: { target: { value: string } }) =>
      setF((cur) => {
        const next = { ...cur, [k]: e.target.value } as ModelDraft;
        if (k === 'model' && !cur.nameTouched) next.name = keyFrom(e.target.value);
        if (k === 'name') next.nameTouched = true;
        if (k === 'providerId' && !initial)
          next.source = presetFor(e.target.value)?.pricingUrl ?? cur.source;
        return next;
      });
  const pricingUrl = presetFor(f.providerId)?.pricingUrl;
  const listId = `models-${f.providerId}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const input = decimal(f.input);
    const output = decimal(f.output);
    const cacheRead = decimal(f.cacheRead);
    const cacheWrite = decimal(f.cacheWrite);
    if (
      input === null ||
      output === null ||
      [input, output, cacheRead, cacheWrite].some(Number.isNaN)
    ) {
      setError('Ceny: liczby, np. 3 albo 0,25 (za milion tokenów).');
      return;
    }
    if (!f.useSimple && !f.useComplex) {
      setError('Wybierz co najmniej jedno zastosowanie modelu.');
      return;
    }
    setBusy(true);
    setError(null);
    const body = {
      model: f.model.trim(),
      maxTokens: Number(f.maxTokens) || 4000,
      dataPolicy: f.dataPolicy,
      pricing: {
        currency: f.currency.trim().toUpperCase(),
        inputPerMTok: input,
        outputPerMTok: output,
        cacheReadPerMTok: cacheRead,
        cacheWritePerMTok: cacheWrite,
        source: f.source.trim() || null,
        verifiedAt: f.verifiedAt || null,
      },
      useSimple: f.useSimple,
      useComplex: f.useComplex,
      priority: Number(f.priority) || 0,
    };
    try {
      onSaved(
        initial
          ? await api.updateHouseholdModel(initial.id, body)
          : await api.addHouseholdModel({
              ...body,
              providerId: f.providerId,
              name: f.name.trim(),
            }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="service-form model-form" onSubmit={(e) => void submit(e)}>
      {!initial && (
        <label>
          Dostawca
          <select value={f.providerId} onChange={set('providerId')} required>
            {data.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Identyfikator modelu u dostawcy
        <input
          value={f.model}
          onChange={set('model')}
          required
          maxLength={120}
          list={listId}
          className="mono"
          placeholder="np. z listy „Sprawdź klucz”"
        />
        <datalist id={listId}>
          {(suggestions[f.providerId] ?? []).map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
      </label>
      {!initial && (
        <label>
          Nazwa w NovaAI
          <input
            value={f.name}
            onChange={set('name')}
            required
            maxLength={60}
            pattern="[a-z0-9][a-z0-9_.\-]{1,59}"
            title="małe litery, cyfry, . - _"
            className="mono"
          />
        </label>
      )}
      <label>
        Waluta cennika
        <input
          value={f.currency}
          onChange={set('currency')}
          required
          maxLength={3}
          pattern="[A-Za-z]{3}"
        />
      </label>
      <label>
        Cena wejścia (za 1 mln tokenów)
        <input value={f.input} onChange={set('input')} inputMode="decimal" required />
      </label>
      <label>
        Cena wyjścia (za 1 mln tokenów)
        <input value={f.output} onChange={set('output')} inputMode="decimal" required />
      </label>
      <label>
        Odczyt z cache (opcjonalnie)
        <input value={f.cacheRead} onChange={set('cacheRead')} inputMode="decimal" />
      </label>
      <label>
        Zapis do cache (opcjonalnie)
        <input value={f.cacheWrite} onChange={set('cacheWrite')} inputMode="decimal" />
      </label>
      <label className="wide">
        Źródło cennika
        <input value={f.source} onChange={set('source')} maxLength={300} />
        {pricingUrl && (
          <a className="small" href={pricingUrl} target="_blank" rel="noopener noreferrer">
            Otwórz aktualny cennik dostawcy
          </a>
        )}
      </label>
      <label>
        Cennik sprawdzony dnia
        <input type="date" value={f.verifiedAt} onChange={set('verifiedAt')} />
      </label>
      <label>
        Maks. długość odpowiedzi (tokeny)
        <input
          type="number"
          min={16}
          max={128000}
          value={f.maxTokens}
          onChange={set('maxTokens')}
        />
      </label>
      <label>
        Priorytet (mniejszy = pierwszy)
        <input type="number" min={0} max={1000} value={f.priority} onChange={set('priority')} />
      </label>
      <label>
        Dane
        <select value={f.dataPolicy} onChange={set('dataPolicy')}>
          <option value="private_ok">prywatne i wspólne rozmowy</option>
          <option value="shared_only">tylko wspólne (NovaAI domu)</option>
        </select>
      </label>
      <fieldset className="wide preset-choice">
        <legend>Zastosowanie</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={f.useSimple}
            onChange={(e) => setF((c) => ({ ...c, useSimple: e.target.checked }))}
          />
          krótkie pytania
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={f.useComplex}
            onChange={(e) => setF((c) => ({ ...c, useComplex: e.target.checked }))}
          />
          złożone zadania i długie rozmowy
        </label>
      </fieldset>
      {error && (
        <p className="note note-danger wide" role="alert">
          {error}
        </p>
      )}
      <div className="row wide">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {initial ? 'Zapisz zmiany' : 'Dodaj model'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Anuluj
        </button>
      </div>
    </form>
  );
}

function ModelItem({
  m,
  data,
  manage,
  suggestions,
  onChanged,
  onError,
}: {
  m: HouseholdModelInfo;
  data: ModelsOverview;
  manage: boolean;
  suggestions: Record<string, string[]>;
  onChanged: (d: ModelsOverview, msg?: string | null) => void;
  onError: (e: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const p = m.pricing;
  const uses = [m.useSimple && 'krótkie pytania', m.useComplex && 'złożone zadania']
    .filter(Boolean)
    .join(', ');
  return (
    <li className="device model-item">
      <div className="row between">
        <span>
          <strong className="mono">{m.name}</strong>{' '}
          <span className="small muted">
            {m.providerName}/{m.model}
          </span>
        </span>
        {m.available ? <Badge tone="ok">używany</Badge> : <Badge tone="warn">{m.reason}</Badge>}
      </div>
      <p className="small muted">
        {fmt(p.inputPerMTok)} / {fmt(p.outputPerMTok)} {p.currency} za mln tokenów (wejście /
        wyjście)
        {p.verifiedAt ? ` · cennik z ${p.verifiedAt}` : ' · cennik niezweryfikowany'} · {uses} ·
        priorytet {m.priority}
        {m.dataPolicy === 'shared_only' ? ' · tylko rozmowy wspólne' : ''}
      </p>
      {manage && !editing && (
        <div className="row service-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            <Icon name="edit" /> Edytuj
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              void run(async () =>
                onChanged(await api.updateHouseholdModel(m.id, { enabled: !m.enabled })),
              )
            }
          >
            {m.enabled ? 'Wyłącz' : 'Włącz'}
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Usunąć model ${m.name}?`)) return;
              void run(async () =>
                onChanged(await api.deleteHouseholdModel(m.id), `Usunięto model ${m.name}.`),
              );
            }}
          >
            <Icon name="trash" /> Usuń
          </button>
        </div>
      )}
      {editing && (
        <ModelForm
          data={data}
          suggestions={suggestions}
          initial={m}
          onSaved={(d) => {
            setEditing(false);
            onChanged(d, `Zapisano model ${m.name}.`);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  );
}

function FxPanel({
  data,
  manage,
  onChanged,
  onError,
}: {
  data: ModelsOverview;
  manage: boolean;
  onChanged: (d: ModelsOverview, msg?: string | null) => void;
  onError: (e: string) => void;
}) {
  const currencies = [...new Set([...data.missingFx, ...data.fx.map((f) => f.currency)])].sort();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (!currencies.length) return null;
  const save = async (currency: string, remove = false) => {
    const rate = remove ? null : decimal(drafts[currency] ?? '');
    if (!remove && (rate === null || Number.isNaN(rate) || rate <= 0)) {
      onError('Kurs: liczba większa od zera, np. 3,95');
      return;
    }
    try {
      onChanged(await api.setFxRate(currency, rate), remove ? `Usunięto kurs ${currency}.` : null);
      setDrafts((d) => ({ ...d, [currency]: '' }));
    } catch (e) {
      onError(errorText(e));
    }
  };
  return (
    <section className="panel">
      <h2 className="h-sub">Kursy walut</h2>
      <p className="small muted">
        Budżet liczony jest w {data.currency}. Cenniki w innych walutach przeliczamy po kursie,
        który tu ustawisz (bez pobierania kursów z internetu).
      </p>
      {data.missingFx.length > 0 && (
        <p className="note note-warn" role="status">
          Brak kursu {data.missingFx.map((c) => `${c}→${data.currency}`).join(', ')} — modele z tym
          cennikiem nie są używane.
        </p>
      )}
      <ul className="devices">
        {currencies.map((c) => {
          const cur = data.fx.find((f) => f.currency === c);
          return (
            <li key={c} className="device">
              <form
                className="row fx-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(c);
                }}
              >
                <span>
                  1 {c} = {cur ? `${fmt(cur.rate)} ${data.currency}` : '—'}
                </span>
                {manage && (
                  <>
                    <label className="row small">
                      Nowy kurs ({data.currency})
                      <input
                        value={drafts[c] ?? ''}
                        onChange={(e) => setDrafts((d) => ({ ...d, [c]: e.target.value }))}
                        inputMode="decimal"
                        placeholder="np. 3,95"
                        size={8}
                        aria-label={`Kurs ${c} w ${data.currency}`}
                      />
                    </label>
                    <button type="submit" className="btn btn-sm">
                      Zapisz kurs
                    </button>
                    {cur && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void save(c, true)}
                      >
                        Usuń
                      </button>
                    )}
                  </>
                )}
              </form>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
