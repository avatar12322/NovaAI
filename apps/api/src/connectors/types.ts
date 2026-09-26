/** Kontrakt integracji. Dostawca może obsługiwać tylko część zdolności. */
export type ConnectorCapability =
  | 'mail.search'
  | 'mail.read'
  | 'mail.send'
  | 'mail.draft'
  | 'calendar.freebusy'
  | 'calendar.read'
  | 'calendar.write'
  /** Wiadomości i wzmianki z kanałów publicznych, do których należy użytkownik. */
  | 'chat.read'
  /** Dodatkowo kanały prywatne użytkownika. */
  | 'chat.read_private'
  /** Dodatkowo rozmowy bezpośrednie (1:1 i grupowe). */
  | 'chat.read_dm'
  | 'chat.send';

export type Provider = 'google' | 'microsoft' | 'slack';

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
  /** Etykieta konta do wyświetlenia (np. adres e-mail z tokenu ID) — nie do autoryzacji. */
  account?: string | null;
  /** Identyfikatory konta u dostawcy (np. workspace i użytkownik Slack) — do przypisania zdarzeń. */
  externalTeamId?: string | null;
  externalUserId?: string | null;
}

export class ConnectorError extends Error {
  constructor(
    public readonly code:
      | 'not_configured'
      | 'not_connected'
      | 'reauth_required'
      | 'provider_error'
      | 'scope_missing'
      /** API odrzuciło token (HTTP 401) — serwis odświeża token i ponawia raz. */
      | 'unauthorized'
      /** Połączono więcej niż jedno konto z tą zdolnością — trzeba wskazać które. */
      | 'ambiguous_account'
      /** To konto u dostawcy jest już połączone przez inną osobę w NovaAI. */
      | 'account_in_use',
    message: string,
    public readonly retryable = false,
    /** Szczegółowy powód do czytelnego komunikatu (np. 'not_in_channel'); domyślnie kod. */
    public readonly reason?: string,
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

export interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  showAs: string;
}

/** Wiadomość z komunikatora (np. Slack) — pobierana na żywo, nie zapisywana w NovaAI. */
export interface ChatMessage {
  author: string;
  authorId: string;
  channelId: string;
  channelName: string;
  ts: string;
  text: string;
  permalink: string;
}

export interface ChatChannel {
  id: string;
  name: string;
  kind: 'public' | 'private' | 'im' | 'mpim';
  isMember: boolean;
  isArchived: boolean;
}

/** Informacja dla użytkownika o ograniczeniu integracji (np. zgoda administratora organizacji). */
export interface ConnectorNote {
  title: string;
  text: string;
}

/**
 * Interfejs connectora: `capabilities`, `connect` (authorizeUrl/exchangeCode), `disconnect` (revoke),
 * `search`/`read`/`execute` (per zdolność), `subscribe` (webhooki), `health` (status konfiguracji).
 */
export interface Connector {
  readonly provider: Provider;
  readonly title: string;
  readonly capabilities: readonly ConnectorCapability[];
  /** Ograniczenia i wymagania pokazywane w Ustawieniach (np. Teams: zgoda administratora). */
  readonly notes?: readonly ConnectorNote[];
  /** Jak cofnąć zgodę po stronie dostawcy, gdy nie ma API do odwołania tokenu. */
  readonly revocationHelp?: string;
  /** null = skonfigurowany; w przeciwnym razie powód („not configured”). */
  configurationError(): string | null;
  scopesFor(caps: readonly ConnectorCapability[]): string[];
  /** Czy przyznane (zapisane) zakresy pozwalają na zdolność. */
  allows(cap: ConnectorCapability, granted: readonly string[]): boolean;
  /** Postać zakresów do zapisu i porównań (np. bez prefiksu zasobu, bez zakresów OIDC). */
  normalizeScopes?(scopes: readonly string[]): string[];
  authorizeUrl(args: {
    state: string;
    codeChallenge: string;
    scopes: string[];
    redirectUri: string;
  }): string;
  exchangeCode(code: string, verifier: string, redirectUri: string): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  /** Odwołanie tokenu u dostawcy; 'unsupported' = dostawca nie ma takiego API. Błąd => wyjątek. */
  revoke(tokens: {
    accessToken: string;
    refreshToken: string | null;
  }): Promise<'revoked' | 'unsupported'>;
  freeBusy?(accessToken: string, timeMin: string, timeMax: string): Promise<BusyInterval[]>;
  mailSearch?(accessToken: string, query: string, max: number): Promise<MailSummary[]>;
  mailRead?(accessToken: string, id: string): Promise<MailMessage>;
  mailSend?(
    accessToken: string,
    msg: { to: string; subject: string; body: string },
  ): Promise<{ id: string }>;
  mailDraft?(
    accessToken: string,
    msg: { to: string; subject: string; body: string },
  ): Promise<{ id: string; webLink: string | null }>;
  calendarEvents?(
    accessToken: string,
    from: string,
    to: string,
    max: number,
  ): Promise<CalendarEvent[]>;
  chatSearch?(
    accessToken: string,
    q: { query: string; channelTypes: string[]; limit: number; after?: number },
  ): Promise<ChatMessage[]>;
  chatChannel?(accessToken: string, channelId: string): Promise<ChatChannel>;
  chatSend?(
    accessToken: string,
    msg: { channel: string; text: string; threadTs?: string },
  ): Promise<{ channel: string; ts: string }>;
}
