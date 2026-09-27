import type {
  FileModelInfo,
  HouseholdModelInfo,
  ModelProviderInfo,
  ModelProviderPreset,
  ModelsOverview,
  ServerProviderInfo,
} from '@nova/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Badge, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { api, errorText } from '../lib/api';

/**
 * „Modele AI i klucze API”: dostawcy (Anthropic, OpenAI, Gemini, inni zgodni z OpenAI), modele z cennikiem
 * i kursy walut. Klucz jest tylko wysyłany — serwer szyfruje go i nigdy nie odsyła (widać ostatnie 4 znaki).
 */
const KIND_PL: Record<ServerProviderInfo['kind'], string> = {
  anthropic: 'Anthropic API',
  openai_compatible: 'zgodny z OpenAI',
  fake: 'demo (bez sieci)',
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
  /** Otwarty formularz nowego modelu (z ewentualnie wypełnionymi polami, np. „Uzupełnij cennik”). */
  const [modelDraft, setModelDraft] = useState<Partial<ModelDraft> | null>(null);
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
  const canAddModel = data.providers.length > 0 || data.serverProviders.some((p) => !p.overridden);
  /** „Uzupełnij cennik” dla modelu z pliku: formularz z dostawcą, nazwą i identyfikatorem modelu. */
  const fillPricing = (m: FileModelInfo) => {
    const own = data.providers.find((p) => p.enabled && p.name === m.provider);
    setModelDraft({
      provider: own ? `p:${own.id}` : `s:${m.provider}`,
      name: m.key,
      model: m.model,
    });
    document.getElementById('models-section')?.scrollIntoView({ block: 'start' });
  };
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
            serverProviders={data.serverProviders}
            vaultReady={data.vaultReady}
            onSaved={(d, name) => {
              setAddingProvider(false);
              apply(d, `Dodano dostawcę ${name}. Sprawdź klucz, a potem dodaj model.`);
            }}
            onCancel={() => setAddingProvider(false)}
          />
        )}
        {data.providers.length === 0 && !addingProvider && (
          <EmptyState title="Brak dostawców w aplikacji">
            <p>
              {manage
                ? data.serverProviders.some((p) => p.usable)
                  ? 'Klucz z pliku .env serwera już działa (niżej) — wystarczy dodać model z cennikiem. Własny klucz możesz też dodać tutaj.'
                  : 'Dodaj klucz API: Anthropic (Claude), OpenAI, Google Gemini albo inny serwer zgodny z OpenAI.'
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

      {(data.serverProviders.length > 0 || data.fileModels.length > 0) && (
        <ServerConfigPanel data={data} manage={manage} onFillPricing={fillPricing} />
      )}

      <section className="panel" id="models-section">
        <div className="row between">
          <h2 className="h-sub">Modele</h2>
          {manage && canAddModel && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setModelDraft(modelDraft ? null : {})}
            >
              <Icon name="plus" /> Dodaj model
            </button>
          )}
        </div>
        <p className="small muted">
          Ceny wpisz z oficjalnego cennika dostawcy (za milion tokenów). NovaAI liczy z nich koszt
          każdej odpowiedzi i pilnuje budżetu — model bez cennika nie jest używany.
        </p>
        {modelDraft && (
          <ModelForm
            key={JSON.stringify(modelDraft)}
            data={data}
            suggestions={suggestions}
            prefill={modelDraft}
            onSaved={(d) => {
              setModelDraft(null);
              apply(d, 'Dodano model.');
            }}
            onCancel={() => setModelDraft(null)}
          />
        )}
        {data.models.length === 0 && !modelDraft && (
          <EmptyState title="Brak modeli">
            <p>
              Dodaj model z cennikiem — u dostawcy dodanego w aplikacji albo na kluczu z serwera
              (np. identyfikator z listy „Sprawdź klucz”).
            </p>
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
    </div>
  );
}

function ProviderForm({
  presets,
  serverProviders,
  vaultReady,
  onSaved,
  onCancel,
}: {
  presets: readonly ModelProviderPreset[];
  serverProviders: ServerProviderInfo[];
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
  const onServer = serverProviders.find((p) => p.name === f.name.trim());

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
      {onServer && (
        <p className="note note-muted wide" role="note">
          Na serwerze jest już dostawca „{onServer.name}”
          {onServer.keyEnv ? ` (klucz ze zmiennej ${onServer.keyEnv} w .env)` : ''}
          {onServer.usable ? ' i działa' : ` — ${onServer.reason}`}. Nie musisz wpisywać klucza
          drugi raz: anuluj i dodaj model na kluczu z serwera („Dodaj model”). Jeśli zapiszesz tu
          własny klucz, dla Twojego domu będzie miał pierwszeństwo.
        </p>
      )}
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
      {p.overridesServer && p.enabled && (
        <p className="small muted">
          Zastępuje dostawcę „{p.name}” z konfiguracji serwera — dla Twojego domu używany jest klucz
          wpisany tutaj.
        </p>
      )}
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
  /** `p:<id>` — dostawca z aplikacji; `s:<nazwa>` — dostawca z konfiguracji serwera (klucz w .env). */
  provider: string;
  model: string;
  name: string;
  nameTouched: boolean;
  currency: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  /** Cena za 1000 wyszukiwań w internecie (Anthropic); puste = wyłączone. */
  webSearch: string;
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
  prefill,
  onSaved,
  onCancel,
}: {
  data: ModelsOverview;
  suggestions: Record<string, string[]>;
  initial?: HouseholdModelInfo;
  prefill?: Partial<ModelDraft>;
  onSaved: (d: ModelsOverview) => void;
  onCancel: () => void;
}) {
  // Dostawcy do wyboru: z aplikacji oraz z serwera (o ile aplikacja ich nie zastępuje).
  const options = [
    ...data.providers.map((p) => ({ value: `p:${p.id}`, name: p.name, label: p.label })),
    ...data.serverProviders
      .filter((p) => !p.overridden)
      .map((p) => ({
        value: `s:${p.name}`,
        name: p.name,
        label: `${p.name} — klucz z serwera${p.keyEnv ? ` (${p.keyEnv})` : ''}${p.usable ? '' : ` — ${p.reason}`}`,
      })),
  ];
  const presetFor = (value: string) => {
    const name = options.find((o) => o.value === value)?.name;
    return data.presets.find((x) => x.name && x.name === name);
  };
  const fromInitial = initial
    ? initial.providerId
      ? `p:${initial.providerId}`
      : `s:${initial.providerName}`
    : null;
  const startProvider = prefill?.provider ?? fromInitial ?? options[0]?.value ?? '';
  const [f, setF] = useState<ModelDraft>(() => ({
    provider: startProvider,
    model: prefill?.model ?? initial?.model ?? '',
    name: prefill?.name ?? initial?.name ?? '',
    nameTouched: !!initial || !!prefill?.name,
    currency: initial?.pricing.currency ?? 'USD',
    input: initial ? String(initial.pricing.inputPerMTok).replace('.', ',') : '',
    output: initial ? String(initial.pricing.outputPerMTok).replace('.', ',') : '',
    cacheRead: initial?.pricing.cacheReadPerMTok?.toString().replace('.', ',') ?? '',
    cacheWrite: initial?.pricing.cacheWritePerMTok?.toString().replace('.', ',') ?? '',
    webSearch: initial?.pricing.webSearchPer1k?.toString().replace('.', ',') ?? '',
    source: initial?.pricing.source ?? presetFor(startProvider)?.pricingUrl ?? '',
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
        if (k === 'provider' && !initial)
          next.source = presetFor(e.target.value)?.pricingUrl ?? cur.source;
        return next;
      });
  const pricingUrl = presetFor(f.provider)?.pricingUrl;
  const providerId = f.provider.startsWith('p:') ? f.provider.slice(2) : null;
  const listId = `models-${f.provider.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const input = decimal(f.input);
    const output = decimal(f.output);
    const cacheRead = decimal(f.cacheRead);
    const cacheWrite = decimal(f.cacheWrite);
    const webSearch = decimal(f.webSearch);
    if (
      input === null ||
      output === null ||
      [input, output, cacheRead, cacheWrite, webSearch].some(Number.isNaN)
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
        webSearchPer1k: webSearch,
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
              ...(providerId ? { providerId } : { serverProvider: f.provider.slice(2) }),
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
          <select value={f.provider} onChange={set('provider')} required>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
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
          {(providerId ? (suggestions[providerId] ?? []) : []).map((id) => (
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
        Wyszukiwanie w internecie — cena za 1000 wyszukań (opcjonalnie)
        <input
          value={f.webSearch}
          onChange={set('webSearch')}
          inputMode="decimal"
          placeholder="puste = asystent nie szuka w internecie"
        />
        <span className="small muted">
          Tylko modele Claude (Anthropic): 10 USD za 1000 wyszukań plus tokeny wyników — wpisz w
          walucie cennika (np. 10 przy USD). Najwyżej 3 wyszukania na odpowiedź, liczone do limitu
          kosztów.
        </span>
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
            {m.providerName}
            {m.serverProvider ? ' (klucz z serwera)' : ''}/{m.model}
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
        {m.overridesServer ? ' · zastępuje model z pliku serwera' : ''}
        {p.webSearchPer1k !== null
          ? ` · wyszukiwanie w internecie: ${fmt(p.webSearchPer1k)} ${p.currency} za 1000`
          : ''}
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

/** Dostawcy i modele z pliku konfiguracyjnego serwera (klucze w .env) — stan i szybkie uzupełnienie cennika. */
function ServerConfigPanel({
  data,
  manage,
  onFillPricing,
}: {
  data: ModelsOverview;
  manage: boolean;
  onFillPricing: (m: FileModelInfo) => void;
}) {
  return (
    <section className="panel server-config">
      <h2 className="h-sub">Z konfiguracji serwera (.env)</h2>
      <p className="small muted">
        Dostawcy i modele z pliku <code>NOVA_MODELS_CONFIG</code> z kluczami w zmiennych
        środowiskowych (plik <code>.env</code>, zmiana wymaga restartu serwera). Wartości kluczy nie
        są tu pokazywane. To, co ustawisz w aplikacji, ma pierwszeństwo dla Twojego domu.
      </p>
      <ul className="devices">
        {data.serverProviders.map((p) => (
          <li key={p.name} className="device server-provider">
            <div className="row between">
              <strong className="mono">{p.name}</strong>
              {p.overridden ? (
                <Badge>zastąpiony dostawcą z aplikacji</Badge>
              ) : p.usable ? (
                <Badge tone="ok">klucz wczytany</Badge>
              ) : (
                <Badge tone="warn">{p.reason}</Badge>
              )}
            </div>
            <p className="small muted">
              {KIND_PL[p.kind]}
              {p.keyEnv ? ` · klucz ze zmiennej ${p.keyEnv}` : ''}
            </p>
          </li>
        ))}
        {data.fileModels.map((m) => {
          const noPrice = !m.available && !m.overridden && !!m.reason?.startsWith('brak cennika');
          return (
            <li key={m.key} className="device file-model">
              <div className="row between">
                <span className="mono">
                  {m.key} ({m.provider}/{m.model})
                </span>
                {m.available ? (
                  <Badge tone="ok">dostępny</Badge>
                ) : m.overridden ? (
                  <Badge>zastąpiony modelem z aplikacji</Badge>
                ) : (
                  <Badge tone="warn">{noPrice ? 'brak cennika' : `niedostępny: ${m.reason}`}</Badge>
                )}
              </div>
              {noPrice && (
                <div className="row between small">
                  <span className="muted">
                    Plik nie ma cennika, więc model nie jest używany (budżet). Wpisz ceny tutaj —
                    klucza nie trzeba podawać ponownie.
                  </span>
                  {manage && (
                    <button type="button" className="btn btn-sm" onClick={() => onFillPricing(m)}>
                      Uzupełnij cennik
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
