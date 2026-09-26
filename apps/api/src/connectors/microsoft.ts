import { buildRfc2822 } from './google';
import {
  ConnectorError,
  type BusyInterval,
  type CalendarEvent,
  type Connector,
  type ConnectorCapability,
  type ConnectorNote,
  type MailMessage,
  type MailSummary,
  type TokenSet,
} from './types';

/**
 * Microsoft Graph (Outlook Mail i Calendar) — uprawnienia delegowane, osobne połączenie każdego użytkownika.
 * Protokół: Microsoft identity platform v2.0, authorization code + PKCE S256, klient poufny (client_secret).
 * Endpointy, uprawnienia i zachowania zweryfikowane w oficjalnej dokumentacji 2026-09-26 (docs/DECISIONS.md D-027).
 * Adresy można podmienić w testach (lokalna atrapa).
 */
export interface MicrosoftEndpoints {
  /** https://login.microsoftonline.com/{tenant}/oauth2/v2.0 */
  authority: string;
  graphBase: string;
}

export const microsoftEndpoints = (tenant: string): MicrosoftEndpoints => ({
  authority: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`,
  graphBase: 'https://graph.microsoft.com/v1.0',
});

const GRAPH_RESOURCE = 'https://graph.microsoft.com/';

/** Zakresy OIDC: refresh token (offline_access) i identyfikacja konta do wyświetlenia (openid, profile). */
const OIDC_SCOPES = ['offline_access', 'openid', 'profile'];

/**
 * Najmniejsze uprawnienie dla zdolności („least privileged” z dokumentacji danego endpointu) oraz uprawnienia,
 * które je obejmują. Bez Mail.ReadWrite, dopóki użytkownik nie włączy szkiców w Outlooku.
 */
const CAPS: Record<string, { request: string; satisfiedBy: string[] }> = {
  'mail.search': {
    request: 'Mail.ReadBasic',
    satisfiedBy: ['Mail.ReadBasic', 'Mail.Read', 'Mail.ReadWrite'],
  },
  'mail.read': { request: 'Mail.Read', satisfiedBy: ['Mail.Read', 'Mail.ReadWrite'] },
  'mail.send': { request: 'Mail.Send', satisfiedBy: ['Mail.Send'] },
  'mail.draft': { request: 'Mail.ReadWrite', satisfiedBy: ['Mail.ReadWrite'] },
  'calendar.read': {
    request: 'Calendars.ReadBasic',
    satisfiedBy: ['Calendars.ReadBasic', 'Calendars.Read', 'Calendars.ReadWrite'],
  },
  'calendar.freebusy': {
    request: 'Calendars.ReadBasic',
    satisfiedBy: ['Calendars.ReadBasic', 'Calendars.Read', 'Calendars.ReadWrite'],
  },
};

/** Uprawnienia obejmujące węższe — nie prosimy o oba naraz. */
const SUBSUMES: Record<string, string[]> = {
  'Mail.Read': ['Mail.ReadBasic'],
  'Mail.ReadWrite': ['Mail.Read', 'Mail.ReadBasic'],
};

const KNOWN = [
  'Mail.ReadBasic',
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.ReadBasic',
  'Calendars.Read',
  'Calendars.ReadWrite',
  'User.Read',
];
const CANONICAL = new Map(KNOWN.map((k) => [k.toLowerCase(), k]));
const OIDC = new Set(['offline_access', 'openid', 'profile', 'email']);

/** Nazwa kanoniczna uprawnienia Graph („https://graph.microsoft.com/mail.read” → „Mail.Read”); OIDC pomijane. */
export function normalizeGraphScopes(scopes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of scopes) {
    const s = decodeURIComponent(raw)
      .trim()
      .replace(/^https:\/\/graph\.microsoft\.com\//i, '');
    if (!s || OIDC.has(s.toLowerCase())) continue;
    out.add(CANONICAL.get(s.toLowerCase()) ?? s);
  }
  return [...out].sort();
}

const TEAMS_NOTE: ConnectorNote = {
  title: 'Microsoft Teams — wymaga zgody administratora organizacji',
  text:
    'Nie zaimplementowano. Odczyt wiadomości z kanałów zespołów wymaga uprawnienia ChannelMessage.Read.All, ' +
    'na które zgodę musi wyrazić administrator organizacji. Czaty (Chat.Read) działają tylko na kontach ' +
    'służbowych lub szkolnych; konta osobiste Microsoft nie mają dostępu do API Teams.',
};
const WORK_ACCOUNT_NOTE: ConnectorNote = {
  title: 'Konta służbowe',
  text:
    'Organizacja może ograniczyć zgody użytkowników — wtedy także poczta i kalendarz wymagają zatwierdzenia ' +
    'przez administratora, a Microsoft pokaże prośbę o zgodę administratora zamiast zwykłego ekranu zgody.',
};

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

const REAUTH_ERRORS = new Set(['invalid_grant', 'interaction_required', 'consent_required']);

/** Etykieta konta z tokenu ID (wyłącznie do wyświetlenia — bez weryfikacji podpisu, nie do autoryzacji). */
function accountFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const v = claims.preferred_username ?? claims.email ?? claims.name;
    return typeof v === 'string' ? v.slice(0, 200) : null;
  } catch {
    return null;
  }
}

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}
interface GraphMessage {
  id: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  body?: { contentType?: string; content?: string };
}
interface GraphEvent {
  id: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  showAs?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
}

const person = (r: GraphRecipient | undefined): string => {
  const a = r?.emailAddress;
  if (!a) return '';
  return a.name && a.address ? `${a.name} <${a.address}>` : (a.address ?? a.name ?? '');
};

/** Czas z Graph (przy `Prefer: outlook.timezone="UTC"` bez przesunięcia, z 7 cyframi ułamka) → ISO UTC. */
export function graphTimeToIso(t: { dateTime?: string; timeZone?: string } | undefined): string {
  const raw = t?.dateTime ?? '';
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?/.exec(raw);
  if (!m) return raw;
  const ms = (m[2] ?? '.000').slice(0, 4).padEnd(4, '0');
  return `${m[1]}${ms}Z`;
}

/** Wartość $search: całość w cudzysłowie; cudzysłów i ukośnik wsteczny poprzedzone „\”. */
const searchValue = (q: string) => `"${q.replace(/["\\]/g, '\\$&')}"`;

export class MicrosoftConnector implements Connector {
  readonly provider = 'microsoft' as const;
  readonly title = 'Microsoft (Outlook: poczta i kalendarz)';
  readonly capabilities: readonly ConnectorCapability[] = [
    'mail.search',
    'mail.read',
    'mail.send',
    'mail.draft',
    'calendar.freebusy',
    'calendar.read',
  ];
  readonly notes: readonly ConnectorNote[] = [TEAMS_NOTE, WORK_ACCOUNT_NOTE];
  readonly revocationHelp =
    'Odłączenie usuwa tokeny z NovaAI. Microsoft nie udostępnia odwołania pojedynczego tokenu aplikacji — ' +
    'zgodę cofniesz na stronie konta: konto osobiste — account.microsoft.com → Prywatność → dostęp aplikacji; ' +
    'konto służbowe — portal Moje aplikacje (myapps.microsoft.com) → Zarządzaj aplikacją → Cofnij uprawnienia.';

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly ep: MicrosoftEndpoints,
    private readonly timeoutMs = 15_000,
  ) {}

  configurationError(): string | null {
    if (!this.clientId || !this.clientSecret)
      return 'brak MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET';
    return null;
  }

  scopesFor(caps: readonly ConnectorCapability[]): string[] {
    const graph = new Set(caps.map((c) => CAPS[c]?.request).filter((s): s is string => !!s));
    for (const s of [...graph]) for (const narrower of SUBSUMES[s] ?? []) graph.delete(narrower);
    return [...OIDC_SCOPES, ...[...graph].sort().map((s) => `${GRAPH_RESOURCE}${s}`)];
  }

  normalizeScopes(scopes: readonly string[]): string[] {
    return normalizeGraphScopes(scopes);
  }

  allows(cap: ConnectorCapability, granted: readonly string[]): boolean {
    const need = CAPS[cap];
    if (!need) return false;
    const have = new Set(normalizeGraphScopes(granted));
    return need.satisfiedBy.some((s) => have.has(s));
  }

  authorizeUrl(a: {
    state: string;
    codeChallenge: string;
    scopes: string[];
    redirectUri: string;
  }): string {
    const u = new URL(`${this.ep.authority}/authorize`);
    u.search = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: a.redirectUri,
      response_mode: 'query',
      scope: a.scopes.join(' '),
      state: a.state,
      code_challenge: a.codeChallenge,
      code_challenge_method: 'S256',
      // Wybór konta zamiast cichego użycia zalogowanego — łatwiej nie pomylić konta osobistego i służbowego.
      prompt: 'select_account',
    }).toString();
    return u.toString();
  }

  private async fetchJson<T>(
    url: string,
    init: RequestInit,
  ): Promise<{ status: number; body: T; retryAfter: string | null }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      let body: unknown = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      return { status: res.status, body: body as T, retryAfter: res.headers.get('retry-after') };
    } catch {
      throw new ConnectorError('provider_error', 'microsoft: brak połączenia', true);
    } finally {
      clearTimeout(timer);
    }
  }

  private toTokenSet(r: TokenResponse, previousRefresh: string | null): TokenSet {
    if (!r.access_token) throw new ConnectorError('provider_error', 'microsoft: brak access_token');
    return {
      accessToken: r.access_token,
      // Microsoft może zwrócić nowy refresh token — należy zastąpić nim poprzedni.
      refreshToken: r.refresh_token ?? previousRefresh,
      expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000,
      scopes: normalizeGraphScopes((r.scope ?? '').split(' ')),
      account: accountFromIdToken(r.id_token),
    };
  }

  private async token(
    params: Record<string, string>,
    previousRefresh: string | null,
  ): Promise<TokenSet> {
    const { status, body } = await this.fetchJson<TokenResponse>(`${this.ep.authority}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        ...params,
      }).toString(),
    });
    if (status >= 400 && body.error && REAUTH_ERRORS.has(body.error)) {
      // Cofnięta zgoda, wygasły refresh token, wymagane MFA/zgoda — tylko ponowne połączenie konta.
      throw new ConnectorError('reauth_required', 'microsoft: wymagane ponowne połączenie konta');
    }
    if (body.error === 'invalid_client' || body.error === 'unauthorized_client') {
      throw new ConnectorError(
        'provider_error',
        'microsoft: aplikacja OAuth odrzucona (sprawdź MICROSOFT_CLIENT_ID/SECRET)',
      );
    }
    if (status >= 400) {
      throw new ConnectorError(
        'provider_error',
        `microsoft: token HTTP ${status}`,
        status >= 500 || body.error === 'temporarily_unavailable',
      );
    }
    return this.toTokenSet(body, previousRefresh);
  }

  exchangeCode(code: string, verifier: string, redirectUri: string): Promise<TokenSet> {
    return this.token(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      null,
    );
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken);
  }

  /**
   * Microsoft identity platform nie ma endpointu odwołania pojedynczego tokenu aplikacji (revokeSignInSessions
   * wylogowałoby użytkownika ze wszystkich aplikacji). Odłączenie usuwa tokeny lokalnie; zgodę użytkownik
   * cofa na stronie konta (revocationHelp).
   */
  async revoke(): Promise<'unsupported'> {
    return 'unsupported';
  }

  private async api<T>(
    accessToken: string,
    path: string,
    init: RequestInit & { prefer?: string } = {},
  ): Promise<T> {
    const url =
      path.startsWith('https://') || path.startsWith('http://')
        ? path
        : `${this.ep.graphBase}${path}`;
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string>) ?? {}),
      authorization: `Bearer ${accessToken}`,
    };
    if (init.prefer) headers.prefer = init.prefer;
    const { status, body } = await this.fetchJson<T>(url, { ...init, headers });
    if (status === 401) throw new ConnectorError('unauthorized', 'microsoft: token odrzucony');
    if (status === 403)
      throw new ConnectorError(
        'scope_missing',
        'microsoft: brak uprawnień (zakres lub zasady organizacji)',
      );
    if (status === 404) throw new ConnectorError('provider_error', 'microsoft: nie znaleziono');
    if (status >= 400)
      throw new ConnectorError(
        'provider_error',
        `microsoft: HTTP ${status}`,
        status === 429 || status >= 500,
      );
    return body;
  }

  async mailSearch(accessToken: string, query: string, max: number): Promise<MailSummary[]> {
    // Mail.ReadBasic nie obejmuje treści ani podglądu — wybieramy tylko nadawcę, temat i datę.
    const top = Math.min(Math.max(max, 1), 20);
    const r = await this.api<{ value?: GraphMessage[] }>(
      accessToken,
      `/me/messages?$search=${encodeURIComponent(searchValue(query))}&$top=${top}` +
        `&$select=${encodeURIComponent('id,subject,from,receivedDateTime')}`,
    );
    return (r.value ?? []).slice(0, top).map((m) => ({
      id: m.id,
      from: person(m.from),
      subject: m.subject ?? '',
      date: m.receivedDateTime ?? '',
      snippet: '',
    }));
  }

  async mailRead(accessToken: string, id: string): Promise<MailMessage> {
    const m = await this.api<GraphMessage>(
      accessToken,
      `/me/messages/${encodeURIComponent(id)}?$select=${encodeURIComponent(
        'id,subject,from,toRecipients,receivedDateTime,body',
      )}`,
      { prefer: 'outlook.body-content-type="text"' },
    );
    return {
      id: m.id,
      from: person(m.from),
      to: (m.toRecipients ?? []).map(person).join(', '),
      subject: m.subject ?? '',
      date: m.receivedDateTime ?? '',
      snippet: '',
      body: (m.body?.content ?? '').slice(0, 50_000),
    };
  }

  private graphMessage(msg: { to: string; subject: string; body: string }) {
    // Ta sama walidacja co dla Gmaila: poprawny adres, brak CR/LF w nagłówkach.
    buildRfc2822(msg);
    return {
      subject: msg.subject,
      body: { contentType: 'Text', content: msg.body },
      toRecipients: [{ emailAddress: { address: msg.to } }],
    };
  }

  async mailSend(
    accessToken: string,
    msg: { to: string; subject: string; body: string },
  ): Promise<{ id: string }> {
    // 202 Accepted bez treści; wiadomość trafia do Elementów wysłanych.
    await this.api(accessToken, '/me/sendMail', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: this.graphMessage(msg), saveToSentItems: true }),
    });
    return { id: '' };
  }

  async mailDraft(
    accessToken: string,
    msg: { to: string; subject: string; body: string },
  ): Promise<{ id: string; webLink: string | null }> {
    const r = await this.api<{ id?: string; webLink?: string }>(accessToken, '/me/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.graphMessage(msg)),
    });
    return { id: r.id ?? '', webLink: r.webLink ?? null };
  }

  private async calendarView(
    accessToken: string,
    from: string,
    to: string,
    select: string,
    max: number,
  ): Promise<GraphEvent[]> {
    const out: GraphEvent[] = [];
    let url: string | null =
      `/me/calendarView?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}` +
      `&$select=${encodeURIComponent(select)}&$top=50`;
    for (let page = 0; url && page < 10 && out.length < max; page++) {
      const r: { value?: GraphEvent[]; '@odata.nextLink'?: string } = await this.api(
        accessToken,
        url,
        { prefer: 'outlook.timezone="UTC"' },
      );
      out.push(...(r.value ?? []));
      const next = r['@odata.nextLink'];
      // Następna strona tylko w obrębie Graph (bez podążania za dowolnym adresem z odpowiedzi).
      url = next && next.startsWith(this.ep.graphBase) ? next : null;
    }
    return out.filter((e) => !e.isCancelled).slice(0, max);
  }

  async calendarEvents(
    accessToken: string,
    from: string,
    to: string,
    max: number,
  ): Promise<CalendarEvent[]> {
    const events = await this.calendarView(
      accessToken,
      from,
      to,
      'id,subject,start,end,location,showAs,isAllDay,isCancelled',
      max,
    );
    return events
      .map((e) => ({
        id: e.id,
        subject: e.subject ?? '',
        start: graphTimeToIso(e.start),
        end: graphTimeToIso(e.end),
        allDay: e.isAllDay === true,
        location: e.location?.displayName ?? '',
        showAs: e.showAs ?? '',
      }))
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  /** Zajętość bez szczegółów: tylko przedziały wydarzeń, które nie są oznaczone jako „wolny”. */
  async freeBusy(accessToken: string, timeMin: string, timeMax: string): Promise<BusyInterval[]> {
    const events = await this.calendarView(
      accessToken,
      timeMin,
      timeMax,
      'start,end,showAs,isCancelled',
      500,
    );
    return events
      .filter((e) => (e.showAs ?? 'busy') !== 'free')
      .map((e) => ({ start: graphTimeToIso(e.start), end: graphTimeToIso(e.end) }))
      .sort((a, b) => a.start.localeCompare(b.start));
  }
}
