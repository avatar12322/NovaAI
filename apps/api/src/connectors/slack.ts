import {
  ConnectorError,
  type ChatChannel,
  type ChatMessage,
  type Connector,
  type ConnectorCapability,
  type ConnectorNote,
  type TokenSet,
} from './types';

/**
 * Slack — token UŻYTKOWNIKA (xoxp), osobne połączenie każdej osoby. Odczyt przez Real-time Search API
 * (`assistant.search.context`), wysyłka `chat.postMessage` jako ta osoba, wyłącznie po zgodzie.
 * Endpointy, zakresy i zasady zweryfikowane w oficjalnej dokumentacji 2026-09-26 (docs/DECISIONS.md D-028).
 *
 * Wyników wyszukiwania NIE zapisujemy (warunek Slacka dla Real-time Search API): narzędzia zwracają
 * tylko metadane, a treść jest pobierana na żywo przy wyświetleniu lub dla modelu.
 *
 * Bez PKCE: w Slacku włączenie PKCE zamienia aplikację w klienta publicznego (bez sekretu, nieodwracalnie).
 * Aplikacja serwerowa uwierzytelnia się sekretem klienta; żądanie wiąże jednorazowy `state`.
 */
export interface SlackEndpoints {
  /** https://slack.com/oauth/v2/authorize */
  authorize: string;
  /** https://slack.com/api */
  api: string;
}

export const SLACK_ENDPOINTS: SlackEndpoints = {
  authorize: 'https://slack.com/oauth/v2/authorize',
  api: 'https://slack.com/api',
};

/**
 * Zakresy użytkownika per zdolność. `assistant.search.context` wymaga `search:read.public` zawsze; kanały prywatne
 * i rozmowy bezpośrednie to osobne, świadome zgody. Wysyłka: `chat:write` oraz odczyt metadanych kanałów
 * publicznych i prywatnych (`conversations.info`), żeby podgląd zgody pokazywał prawdziwą nazwę kanału.
 */
const CAPS: Partial<Record<ConnectorCapability, string[]>> = {
  'chat.read': ['search:read.public'],
  'chat.read_private': ['search:read.public', 'search:read.private'],
  'chat.read_dm': ['search:read.public', 'search:read.im', 'search:read.mpim'],
  'chat.send': ['chat:write', 'channels:read', 'groups:read'],
};

/** Typy rozmów dla wyszukiwania, zależnie od przyznanych zdolności. */
export function channelTypesFor(caps: readonly ConnectorCapability[]): string[] {
  const out = ['public_channel'];
  if (caps.includes('chat.read_private')) out.push('private_channel');
  if (caps.includes('chat.read_dm')) out.push('im', 'mpim');
  return out;
}

const NOTES: ConnectorNote[] = [
  {
    title: 'Wyniki ze Slacka nie są zapisywane',
    text:
      'Zasady Slacka dla wyszukiwania (Real-time Search API) zabraniają przechowywania pobranych wiadomości. ' +
      'NovaAI zapisuje tylko liczbę wyników; treść pobiera na żywo, gdy ją otworzysz lub gdy asystent odpowiada.',
  },
  {
    title: 'Wymagania workspace’u',
    text:
      'Wyszukiwanie działa dla aplikacji wewnętrznych (utworzonych w Twoim workspace) albo opublikowanych ' +
      'w Slack Marketplace. Jeśli workspace wymaga zatwierdzania aplikacji, administrator musi zatwierdzić NovaAI ' +
      'przed połączeniem.',
  },
];

interface SlackResponse {
  ok?: boolean;
  error?: string;
  needed?: string;
  [k: string]: unknown;
}

const REAUTH = new Set([
  'invalid_auth',
  'token_revoked',
  'account_inactive',
  'not_authed',
  'invalid_refresh_token',
  'user_removed_from_team',
  'team_disabled',
]);
const RETRYABLE = new Set([
  'ratelimited',
  'rate_limited',
  'fatal_error',
  'internal_error',
  'service_unavailable',
  'request_timeout',
]);
/** Błędy z czytelnym, szczegółowym powodem (bez ponowień). */
const DETAILED: Record<string, { reason: string; message: string }> = {
  not_in_channel: { reason: 'not_in_channel', message: 'nie należysz do tego kanału' },
  channel_not_found: { reason: 'channel_not_found', message: 'nie znaleziono kanału' },
  is_archived: { reason: 'is_archived', message: 'kanał jest zarchiwizowany' },
  restricted_action: {
    reason: 'restricted_action',
    message: 'zasady workspace’u nie pozwalają na tę akcję',
  },
  msg_too_long: { reason: 'msg_too_long', message: 'wiadomość jest za długa' },
  thread_not_found: { reason: 'channel_not_found', message: 'nie znaleziono wątku' },
  access_denied: { reason: 'search_disabled', message: 'wyszukiwanie jest niedostępne' },
  assistant_search_context_disabled: {
    reason: 'search_disabled',
    message: 'wyszukiwanie dla aplikacji jest wyłączone w tym workspace',
  },
  feature_not_enabled: {
    reason: 'search_disabled',
    message: 'wyszukiwanie dla aplikacji nie jest włączone',
  },
};

/** Tokeny bez rotacji w Slacku nie wygasają; zapisujemy odległy termin. */
const NO_EXPIRY_MS = 10 * 365 * 24 * 3600_000;

export class SlackConnector implements Connector {
  readonly provider = 'slack' as const;
  readonly title = 'Slack (wzmianki, wiadomości, wysyłka)';
  readonly capabilities: readonly ConnectorCapability[] = [
    'chat.read',
    'chat.read_private',
    'chat.read_dm',
    'chat.send',
  ];
  readonly notes = NOTES;
  readonly revocationHelp =
    'Odłączenie odwołuje token w Slacku (auth.revoke) i usuwa go z NovaAI. Aplikację możesz też usunąć ' +
    'w Slacku: kliknij nazwę workspace’u → Narzędzia i ustawienia → Zarządzaj aplikacjami.';

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly ep: SlackEndpoints = SLACK_ENDPOINTS,
    private readonly timeoutMs = 10_000,
  ) {}

  configurationError(): string | null {
    if (!this.clientId || !this.clientSecret) return 'brak SLACK_CLIENT_ID / SLACK_CLIENT_SECRET';
    return null;
  }

  scopesFor(caps: readonly ConnectorCapability[]): string[] {
    return [...new Set(caps.flatMap((c) => CAPS[c] ?? []))].sort();
  }

  normalizeScopes(scopes: readonly string[]): string[] {
    return [...new Set(scopes.flatMap((s) => s.split(',')).map((s) => s.trim()))]
      .filter(Boolean)
      .sort();
  }

  allows(cap: ConnectorCapability, granted: readonly string[]): boolean {
    const need = CAPS[cap];
    return !!need && need.every((s) => granted.includes(s));
  }

  authorizeUrl(a: {
    state: string;
    codeChallenge: string;
    scopes: string[];
    redirectUri: string;
  }): string {
    const u = new URL(this.ep.authorize);
    // Tylko zakresy UŻYTKOWNIKA (`user_scope`); bez zakresów bota (`scope`) — aplikacja działa w imieniu osoby.
    u.search = new URLSearchParams({
      client_id: this.clientId,
      user_scope: a.scopes.join(','),
      redirect_uri: a.redirectUri,
      state: a.state,
    }).toString();
    return u.toString();
  }

  private async post(
    method: string,
    params: Record<string, string>,
    token?: string,
  ): Promise<SlackResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.ep.api}/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: new URLSearchParams(params).toString(),
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch {
      throw new ConnectorError('provider_error', 'slack: brak połączenia z usługą', true);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429)
      throw new ConnectorError(
        'provider_error',
        `slack: limit zapytań (ponów po ${res.headers.get('retry-after') ?? '?'} s)`,
        true,
        'rate_limited',
      );
    if (res.status >= 500)
      throw new ConnectorError('provider_error', `slack: HTTP ${res.status}`, true);
    let body: SlackResponse;
    try {
      body = JSON.parse(text) as SlackResponse;
    } catch {
      throw new ConnectorError(
        'provider_error',
        `slack: nieprawidłowa odpowiedź (HTTP ${res.status})`,
      );
    }
    if (body.ok === true) return body;
    const err = String(body.error ?? 'unknown_error');
    if (err === 'token_expired') throw new ConnectorError('unauthorized', 'slack: token wygasł');
    if (REAUTH.has(err))
      throw new ConnectorError('reauth_required', `slack: ${err} — wymagane ponowne połączenie`);
    if (err === 'missing_scope')
      throw new ConnectorError(
        'scope_missing',
        `slack: brak uprawnienia ${typeof body.needed === 'string' ? body.needed : ''}`.trim(),
      );
    if (RETRYABLE.has(err))
      throw new ConnectorError('provider_error', `slack: ${err}`, true, 'rate_limited');
    const d = DETAILED[err];
    if (d) throw new ConnectorError('provider_error', `slack: ${d.message}`, false, d.reason);
    throw new ConnectorError('provider_error', `slack: ${err}`);
  }

  private clientParams() {
    return { client_id: this.clientId, client_secret: this.clientSecret };
  }

  async exchangeCode(code: string, _verifier: string, redirectUri: string): Promise<TokenSet> {
    let r: SlackResponse;
    try {
      r = await this.post('oauth.v2.access', {
        ...this.clientParams(),
        code,
        redirect_uri: redirectUri,
      });
    } catch (e) {
      // Zły lub zużyty kod, niezgodny redirect, zły klient — logowanie trzeba zacząć od nowa.
      if (e instanceof ConnectorError && !e.retryable && e.code === 'provider_error')
        throw new ConnectorError('provider_error', 'slack: wymiana kodu odrzucona');
      throw e;
    }
    const user = r.authed_user as
      | {
          id?: string;
          access_token?: string;
          scope?: string;
          refresh_token?: string;
          expires_in?: number;
        }
      | undefined;
    const team = r.team as { id?: string; name?: string } | undefined;
    if (!user?.access_token || !user.id || !team?.id)
      throw new ConnectorError('provider_error', 'slack: brak tokenu użytkownika w odpowiedzi');
    // auth.test (bez zakresów): potwierdza, że token należy do tej osoby i tego workspace’u; nazwa do etykiety.
    const who = await this.post('auth.test', {}, user.access_token);
    if (who.user_id !== user.id || who.team_id !== team.id)
      throw new ConnectorError('provider_error', 'slack: niezgodna tożsamość tokenu');
    const name = typeof who.user === 'string' ? who.user : user.id;
    const teamName = typeof who.team === 'string' ? who.team : (team.name ?? team.id);
    return {
      accessToken: user.access_token,
      refreshToken: user.refresh_token ?? null,
      expiresAt: user.expires_in ? Date.now() + user.expires_in * 1000 : Date.now() + NO_EXPIRY_MS,
      scopes: this.normalizeScopes([user.scope ?? '']),
      account: `@${name} · ${teamName}`.slice(0, 200),
      externalTeamId: team.id,
      externalUserId: user.id,
    };
  }

  /** Rotacja tokenów (opcjonalne ustawienie aplikacji): refresh token jednorazowy — zawsze zastępowany. */
  async refresh(refreshToken: string): Promise<TokenSet> {
    const r = await this.post('oauth.v2.access', {
      ...this.clientParams(),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    if (typeof r.access_token !== 'string')
      throw new ConnectorError('provider_error', 'slack: brak access_token po odświeżeniu');
    return {
      accessToken: r.access_token,
      refreshToken: typeof r.refresh_token === 'string' ? r.refresh_token : refreshToken,
      expiresAt:
        typeof r.expires_in === 'number'
          ? Date.now() + r.expires_in * 1000
          : Date.now() + NO_EXPIRY_MS,
      scopes: this.normalizeScopes([typeof r.scope === 'string' ? r.scope : '']),
    };
  }

  async revoke(t: { accessToken: string }): Promise<'revoked'> {
    try {
      await this.post('auth.revoke', {}, t.accessToken);
    } catch (e) {
      // Token już nieważny (odwołany, konto usunięte) = cel osiągnięty.
      if (e instanceof ConnectorError && e.code === 'reauth_required') return 'revoked';
      throw e;
    }
    return 'revoked';
  }

  async chatSearch(
    token: string,
    q: { query: string; channelTypes: string[]; limit: number; after?: number },
  ): Promise<ChatMessage[]> {
    const r = await this.post(
      'assistant.search.context',
      {
        query: q.query,
        channel_types: q.channelTypes.join(','),
        content_types: 'messages',
        limit: String(Math.min(Math.max(q.limit, 1), 20)),
        // Wyszukiwanie po słowach (bez semantycznego) i od najnowszych — przewidywalne dla wzmianek.
        sort: 'timestamp',
        sort_dir: 'desc',
        include_bots: 'false',
        ...(q.after ? { after: String(Math.floor(q.after)) } : {}),
      },
      token,
    );
    const results = r.results as { messages?: Array<Record<string, unknown>> } | undefined;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return (results?.messages ?? []).slice(0, 20).map((m) => ({
      author: str(m.author_name),
      authorId: str(m.author_user_id),
      channelId: str(m.channel_id),
      channelName: str(m.channel_name),
      ts: str(m.message_ts),
      text: str(m.content).slice(0, 4000),
      permalink: str(m.permalink),
    }));
  }

  async chatChannel(token: string, channelId: string): Promise<ChatChannel> {
    const r = await this.post('conversations.info', { channel: channelId }, token);
    const c = (r.channel ?? {}) as Record<string, unknown>;
    return {
      id: typeof c.id === 'string' ? c.id : channelId,
      name: typeof c.name === 'string' ? c.name : '',
      kind: c.is_im ? 'im' : c.is_mpim ? 'mpim' : c.is_private ? 'private' : 'public',
      isMember: c.is_member === true,
      isArchived: c.is_archived === true,
    };
  }

  async chatSend(
    token: string,
    msg: { channel: string; text: string; threadTs?: string },
  ): Promise<{ channel: string; ts: string }> {
    const r = await this.post(
      'chat.postMessage',
      {
        channel: msg.channel,
        text: msg.text,
        ...(msg.threadTs ? { thread_ts: msg.threadTs } : {}),
        // Bez rozwijania podglądów linków — wysyłamy dokładnie to, co było w podglądzie zgody.
        unfurl_links: 'false',
        unfurl_media: 'false',
      },
      token,
    );
    return {
      channel: typeof r.channel === 'string' ? r.channel : msg.channel,
      ts: typeof r.ts === 'string' ? r.ts : '',
    };
  }
}
