import {
  ConnectorError,
  type BusyInterval,
  type Connector,
  type ConnectorCapability,
  type MailMessage,
  type MailSummary,
  type TokenSet,
} from './types';

/**
 * Google (OAuth 2.0 web server + PKCE S256; Calendar freeBusy; Gmail). Endpointy i zakresy zweryfikowane
 * w oficjalnej dokumentacji 2026-09-25 (patrz docs/DECISIONS.md D-019). Adresy można podmienić w testach.
 */
export interface GoogleEndpoints {
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  calendarBase: string;
  gmailBase: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  calendarBase: 'https://www.googleapis.com/calendar/v3',
  gmailBase: 'https://gmail.googleapis.com/gmail/v1',
};

/** Minimalne zakresy per zdolność. */
const SCOPES: Partial<Record<ConnectorCapability, string>> = {
  'calendar.freebusy': 'https://www.googleapis.com/auth/calendar.freebusy',
  'mail.search': 'https://www.googleapis.com/auth/gmail.readonly',
  'mail.read': 'https://www.googleapis.com/auth/gmail.readonly',
  'mail.send': 'https://www.googleapis.com/auth/gmail.send',
};

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function encodeHeader(v: string): string {
  // RFC 2047 dla znaków spoza ASCII (np. polskie litery w temacie).
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/** Wiadomość RFC 2822. Odrzuca CR/LF w nagłówkach (header injection). */
export function buildRfc2822(msg: { to: string; subject: string; body: string }): string {
  if (/[\r\n]/.test(msg.to) || /[\r\n]/.test(msg.subject))
    throw new ConnectorError('provider_error', 'Niedozwolone znaki w nagłówkach');
  if (!EMAIL_RE.test(msg.to))
    throw new ConnectorError('provider_error', 'Nieprawidłowy adres odbiorcy');
  const body = Buffer.from(msg.body, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  return [
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

export class GoogleConnector implements Connector {
  readonly provider = 'google' as const;
  readonly title = 'Google (Gmail, Kalendarz)';
  readonly capabilities: readonly ConnectorCapability[] = [
    'calendar.freebusy',
    'mail.search',
    'mail.read',
    'mail.send',
  ];

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly ep: GoogleEndpoints = GOOGLE_ENDPOINTS,
    private readonly timeoutMs = 15_000,
  ) {}

  configurationError(): string | null {
    if (!this.clientId || !this.clientSecret) return 'brak GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET';
    return null;
  }

  scopesFor(caps: readonly ConnectorCapability[]): string[] {
    return [...new Set(caps.map((c) => SCOPES[c]).filter((s): s is string => !!s))].sort();
  }

  allows(cap: ConnectorCapability, granted: readonly string[]): boolean {
    const scope = SCOPES[cap];
    return !!scope && granted.includes(scope);
  }

  authorizeUrl(a: {
    state: string;
    codeChallenge: string;
    scopes: string[];
    redirectUri: string;
  }): string {
    const u = new URL(this.ep.authUrl);
    u.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: a.redirectUri,
      response_type: 'code',
      scope: a.scopes.join(' '),
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state: a.state,
      code_challenge: a.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return u.toString();
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<{ status: number; body: T }> {
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
      return { status: res.status, body: body as T };
    } catch {
      throw new ConnectorError('provider_error', 'google: brak połączenia', true);
    } finally {
      clearTimeout(timer);
    }
  }

  private toTokenSet(r: TokenResponse, previousRefresh: string | null): TokenSet {
    if (!r.access_token) throw new ConnectorError('provider_error', 'google: brak access_token');
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token ?? previousRefresh,
      expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000,
      scopes: (r.scope ?? '').split(' ').filter(Boolean),
    };
  }

  private async token(
    params: Record<string, string>,
    previousRefresh: string | null,
  ): Promise<TokenSet> {
    const { status, body } = await this.fetchJson<TokenResponse>(this.ep.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        ...params,
      }).toString(),
    });
    if (status === 400 && body.error === 'invalid_grant') {
      throw new ConnectorError('reauth_required', 'google: wymagane ponowne połączenie konta');
    }
    if (status >= 400)
      throw new ConnectorError('provider_error', `google: token HTTP ${status}`, status >= 500);
    return this.toTokenSet(body, previousRefresh);
  }

  exchangeCode(code: string, verifier: string, redirectUri: string): Promise<TokenSet> {
    return this.token(
      {
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      },
      null,
    );
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.token({ refresh_token: refreshToken, grant_type: 'refresh_token' }, refreshToken);
  }

  async revoke(t: { accessToken: string; refreshToken: string | null }): Promise<'revoked'> {
    // Odwołanie refresh tokenu unieważnia też wydane z niego tokeny dostępu.
    await this.fetchJson(this.ep.revokeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t.refreshToken ?? t.accessToken }).toString(),
    });
    return 'revoked';
  }

  private async api<T>(accessToken: string, url: string, init: RequestInit = {}): Promise<T> {
    const { status, body } = await this.fetchJson<T>(url, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${accessToken}` },
    });
    // 401: serwis odświeża token i ponawia raz (ConnectionService.call); dopiero drugie 401 => reauth.
    if (status === 401) throw new ConnectorError('unauthorized', 'google: token odrzucony');
    if (status === 403)
      throw new ConnectorError('scope_missing', 'google: brak uprawnień (zakres)');
    if (status >= 400)
      throw new ConnectorError(
        'provider_error',
        `google: HTTP ${status}`,
        status === 429 || status >= 500,
      );
    return body;
  }

  async freeBusy(accessToken: string, timeMin: string, timeMax: string): Promise<BusyInterval[]> {
    const r = await this.api<{
      calendars?: Record<string, { busy?: BusyInterval[]; errors?: unknown[] }>;
    }>(accessToken, `${this.ep.calendarBase}/freeBusy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeMin, timeMax, items: [{ id: 'primary' }] }),
    });
    const cal = r.calendars?.primary;
    if (cal?.errors?.length) throw new ConnectorError('provider_error', 'google: błąd kalendarza');
    return (cal?.busy ?? []).map((b) => ({ start: b.start, end: b.end }));
  }

  async mailSearch(accessToken: string, query: string, max: number): Promise<MailSummary[]> {
    const q = new URLSearchParams({ q: query, maxResults: String(Math.min(max, 20)) });
    const list = await this.api<{ messages?: Array<{ id: string }> }>(
      accessToken,
      `${this.ep.gmailBase}/users/me/messages?${q}`,
    );
    const out: MailSummary[] = [];
    for (const m of list.messages ?? []) {
      const meta = new URLSearchParams([
        ['format', 'metadata'],
        ['metadataHeaders', 'From'],
        ['metadataHeaders', 'Subject'],
        ['metadataHeaders', 'Date'],
      ]);
      const full = await this.api<GmailMessage>(
        accessToken,
        `${this.ep.gmailBase}/users/me/messages/${encodeURIComponent(m.id)}?${meta}`,
      );
      out.push(summary(full));
    }
    return out;
  }

  async mailRead(accessToken: string, id: string): Promise<MailMessage> {
    const full = await this.api<GmailMessage>(
      accessToken,
      `${this.ep.gmailBase}/users/me/messages/${encodeURIComponent(id)}?format=full`,
    );
    return {
      ...summary(full),
      to: header(full, 'To'),
      body: textBody(full.payload).slice(0, 50_000),
    };
  }

  async mailSend(
    accessToken: string,
    msg: { to: string; subject: string; body: string },
  ): Promise<{ id: string }> {
    const raw = b64url(buildRfc2822(msg));
    const r = await this.api<{ id?: string }>(
      accessToken,
      `${this.ep.gmailBase}/users/me/messages/send`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw }),
      },
    );
    return { id: r.id ?? '' };
  }
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: Array<{ name: string; value: string }>;
}
interface GmailMessage {
  id: string;
  snippet?: string;
  payload?: GmailPart;
}

const header = (m: GmailMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const summary = (m: GmailMessage): MailSummary => ({
  id: m.id,
  from: header(m, 'From'),
  subject: header(m, 'Subject'),
  date: header(m, 'Date'),
  snippet: m.snippet ?? '',
});

function textBody(p: GmailPart | undefined): string {
  if (!p) return '';
  if (p.mimeType === 'text/plain' && p.body?.data)
    return Buffer.from(p.body.data, 'base64url').toString('utf8');
  for (const part of p.parts ?? []) {
    const t = textBody(part);
    if (t) return t;
  }
  return '';
}
