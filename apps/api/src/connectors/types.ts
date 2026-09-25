/** Kontrakt integracji. Dostawca może obsługiwać tylko część zdolności. */
export type ConnectorCapability =
  | 'mail.search'
  | 'mail.read'
  | 'mail.send'
  | 'calendar.freebusy'
  | 'calendar.read'
  | 'calendar.write'
  | 'chat.read'
  | 'chat.send';

export type Provider = 'google' | 'microsoft' | 'slack';

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
}

export class ConnectorError extends Error {
  constructor(
    public readonly code:
      'not_configured' | 'not_connected' | 'reauth_required' | 'provider_error' | 'scope_missing',
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

export interface BusyInterval {
  start: string;
  end: string;
}

export interface MailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface MailMessage extends MailSummary {
  to: string;
  body: string;
}

/**
 * Interfejs connectora: `capabilities`, `connect` (authorizeUrl/exchangeCode), `disconnect` (revoke),
 * `search`/`read`/`execute` (per zdolność), `subscribe` (webhooki), `health` (status konfiguracji).
 */
export interface Connector {
  readonly provider: Provider;
  readonly title: string;
  readonly capabilities: readonly ConnectorCapability[];
  /** null = skonfigurowany; w przeciwnym razie powód („not configured”). */
  configurationError(): string | null;
  scopesFor(caps: readonly ConnectorCapability[]): string[];
  authorizeUrl(args: {
    state: string;
    codeChallenge: string;
    scopes: string[];
    redirectUri: string;
  }): string;
  exchangeCode(code: string, verifier: string, redirectUri: string): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  revoke(token: string): Promise<void>;
  freeBusy?(accessToken: string, timeMin: string, timeMax: string): Promise<BusyInterval[]>;
  mailSearch?(accessToken: string, query: string, max: number): Promise<MailSummary[]>;
  mailRead?(accessToken: string, id: string): Promise<MailMessage>;
  mailSend?(
    accessToken: string,
    msg: { to: string; subject: string; body: string },
  ): Promise<{ id: string }>;
}
