import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config';
import { withSystemTx, type Db } from '../db/pool';
import { sha256 } from '../lib/crypto';
import {
  ConnectorError,
  type Connector,
  type ConnectorCapability,
  type ConnectorNote,
  type Provider,
  type TokenSet,
} from './types';
import type { Vault } from './vault';

const STATE_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 60_000;

interface ConnRow {
  id: string;
  owner_user_id: string;
  household_id: string;
  provider: Provider;
  status: 'connected' | 'revoked' | 'error';
  scopes: string[];
  /** Zdolności wybrane przez użytkownika przy łączeniu; null = połączenie sprzed migracji 0011. */
  capabilities: ConnectorCapability[] | null;
  account_label: string | null;
  token_ciphertext: Buffer | null;
  key_id: string | null;
  access_expires_at: string | null;
  last_error: string | null;
  updated_at: string;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

export interface ConnectionInfo {
  provider: Provider;
  title: string;
  capabilities: readonly ConnectorCapability[];
  configured: boolean;
  reason: string | null;
  /** Uprawnienia dostawcy, o które poprosimy dla każdej zdolności (np. „Mail.ReadBasic”). */
  permissions: Partial<Record<ConnectorCapability, string[]>>;
  notes: readonly ConnectorNote[];
  revocationHelp: string | null;
  connection: {
    status: string;
    scopes: string[];
    /** Zdolności faktycznie dostępne (wybór użytkownika ∩ przyznane zakresy). */
    capabilities: ConnectorCapability[];
    account: string | null;
    updatedAt: string;
    lastError: string | null;
  } | null;
}

const aad = (userId: string, provider: string, connId: string) => `${userId}|${provider}|${connId}`;

/** Krótka nazwa uprawnienia do wyświetlenia („gmail.readonly”, „Mail.Read”). */
const shownScopes = (c: Connector, scopes: string[]) =>
  c.normalizeScopes ? c.normalizeScopes(scopes) : scopes.map((s) => s.split('/').pop() ?? s);

/**
 * Połączenia OAuth per użytkownik. Tokeny wyłącznie zaszyfrowane (Vault), nigdy w logach ani odpowiedziach.
 * Brak sejfu (NOVA_SECRET_KEY) lub klienta OAuth => „not configured”.
 */
export class ConnectionService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly vault: Vault | null,
    readonly connectors: ReadonlyMap<Provider, Connector>,
    readonly unsupported: ReadonlyArray<{
      provider: Provider;
      title: string;
      reason: string;
      notes?: readonly ConnectorNote[];
    }> = [],
  ) {}

  redirectUri(provider: Provider): string {
    return `${this.config.publicUrl}/api/connections/${provider}/callback`;
  }

  connector(provider: Provider): Connector {
    const c = this.connectors.get(provider);
    if (!c)
      throw new ConnectorError(
        'not_configured',
        `Integracja ${provider} nie jest dostępna w tej wersji`,
      );
    const err = this.configurationError(c);
    if (err) throw new ConnectorError('not_configured', err);
    return c;
  }

  private configurationError(c: Connector): string | null {
    if (!this.vault) return 'brak NOVA_SECRET_KEY (szyfrowanie tokenów)';
    return c.configurationError();
  }

  /** Zdolność dostępna w połączeniu: wybrana przez użytkownika i objęta przyznanymi zakresami. */
  private rowAllows(c: Connector, row: ConnRow, cap: ConnectorCapability): boolean {
    if (!c.capabilities.includes(cap)) return false;
    if (row.capabilities && !row.capabilities.includes(cap)) return false;
    return c.allows(cap, row.scopes);
  }

  private async row(userId: string, provider: Provider): Promise<ConnRow | null> {
    const r = await this.db.owner.query<ConnRow>(
      `SELECT * FROM connections WHERE owner_user_id = $1 AND provider = $2 AND status <> 'revoked'`,
      [userId, provider],
    );
    return r.rows[0] ?? null;
  }

  async list(userId: string): Promise<ConnectionInfo[]> {
    const out: ConnectionInfo[] = [];
    for (const c of this.connectors.values()) {
      const err = this.configurationError(c);
      const row = await this.row(userId, c.provider);
      out.push({
        provider: c.provider,
        title: c.title,
        capabilities: c.capabilities,
        configured: err === null,
        reason: err,
        permissions: Object.fromEntries(
          c.capabilities.map((cap) => [cap, shownScopes(c, c.scopesFor([cap]))]),
        ),
        notes: c.notes ?? [],
        revocationHelp: c.revocationHelp ?? null,
        connection: row
          ? {
              status: row.status,
              scopes: row.scopes,
              capabilities: c.capabilities.filter((cap) => this.rowAllows(c, row, cap)),
              account: row.account_label,
              updatedAt: row.updated_at,
              lastError: row.last_error,
            }
          : null,
      });
    }
    for (const u of this.unsupported) {
      out.push({
        provider: u.provider,
        title: u.title,
        capabilities: [],
        configured: false,
        reason: u.reason,
        permissions: {},
        notes: u.notes ?? [],
        revocationHelp: null,
        connection: null,
      });
    }
    return out;
  }

  /** Początek OAuth: state (jednorazowy, 10 min) + PKCE S256; weryfikator zaszyfrowany w bazie. */
  async start(
    userId: string,
    householdId: string,
    provider: Provider,
    caps: ConnectorCapability[],
  ): Promise<string> {
    const c = this.connector(provider);
    const unknown = caps.filter((x) => !c.capabilities.includes(x));
    if (unknown.length)
      throw new ConnectorError('scope_missing', `Nieobsługiwane zdolności: ${unknown.join(', ')}`);
    const scopes = c.scopesFor(caps);
    const chosen = [...new Set(caps)].sort();
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const enc = this.vault!.encrypt(verifier, `oauth|${userId}|${provider}`);
    await this.db.owner.query(
      `INSERT INTO oauth_states (owner_user_id, household_id, provider, state_hash, verifier_cipher, key_id, scopes, capabilities, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        userId,
        householdId,
        provider,
        sha256(state),
        enc.blob,
        enc.keyId,
        scopes,
        chosen,
        new Date(Date.now() + STATE_TTL_MS),
      ],
    );
    return c.authorizeUrl({
      state,
      codeChallenge: challenge,
      scopes,
      redirectUri: this.redirectUri(provider),
    });
  }

  /** Callback: state identyfikuje użytkownika (jednorazowo); wymiana kodu z weryfikatorem PKCE. */
  async callback(
    provider: Provider,
    state: string,
    code: string,
  ): Promise<{ userId: string; householdId: string }> {
    const c = this.connector(provider);
    const st = await withSystemTx(this.db, async (tx) => {
      const r = await tx.query<{
        id: string;
        owner_user_id: string;
        household_id: string;
        verifier_cipher: Buffer;
        key_id: string;
        scopes: string[];
        capabilities: ConnectorCapability[] | null;
      }>(
        `UPDATE oauth_states SET used_at = now()
          WHERE state_hash = $1 AND provider = $2 AND used_at IS NULL AND expires_at > now()
          RETURNING id, owner_user_id, household_id, verifier_cipher, key_id, scopes, capabilities`,
        [sha256(state), provider],
      );
      return r.rows[0] ?? null;
    });
    if (!st) throw new ConnectorError('not_connected', 'Nieprawidłowy lub wygasły stan OAuth');
    const verifier = this.vault!.decrypt(
      st.verifier_cipher,
      st.key_id,
      `oauth|${st.owner_user_id}|${provider}`,
    );
    const tokens = await c.exchangeCode(code, verifier, this.redirectUri(provider));
    // Porównanie w postaci kanonicznej (Microsoft zwraca np. „Mail.Read” zamiast pełnego URI, bez zakresów OIDC).
    const norm = (x: readonly string[]) => (c.normalizeScopes ? c.normalizeScopes(x) : [...x]);
    const granted = norm(tokens.scopes);
    const missing = norm(st.scopes).filter((s) => !granted.includes(s));
    await withSystemTx(this.db, async (tx) => {
      await tx.query(
        `UPDATE connections SET status = 'revoked', revoked_at = now(), token_ciphertext = NULL
          WHERE owner_user_id = $1 AND provider = $2 AND status <> 'revoked'`,
        [st.owner_user_id, provider],
      );
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO connections (household_id, owner_user_id, provider, status, scopes, capabilities, account_label, last_error)
         VALUES ($1,$2,$3,'connected',$4,$5,$6,$7) RETURNING id`,
        [
          st.household_id,
          st.owner_user_id,
          provider,
          granted,
          st.capabilities,
          tokens.account?.slice(0, 200) ?? null,
          missing.length ? `brak zakresów: ${missing.join(' ')}` : null,
        ],
      );
      await this.store(tx, ins.rows[0]!.id, st.owner_user_id, provider, tokens);
    });
    return { userId: st.owner_user_id, householdId: st.household_id };
  }

  private async store(
    q: { query: Db['owner']['query'] },
    connId: string,
    userId: string,
    provider: Provider,
    t: TokenSet,
  ): Promise<void> {
    const payload: StoredTokens = {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      expiresAt: t.expiresAt,
    };
    const enc = this.vault!.encrypt(JSON.stringify(payload), aad(userId, provider, connId));
    await q.query(
      `UPDATE connections SET token_ciphertext = $2, key_id = $3, access_expires_at = $4, updated_at = now() WHERE id = $1`,
      [connId, enc.blob, enc.keyId, new Date(t.expiresAt)],
    );
  }

  private decode(row: ConnRow): StoredTokens {
    if (!row.token_ciphertext || !row.key_id)
      throw new ConnectorError('not_connected', 'Brak tokenów');
    return JSON.parse(
      this.vault!.decrypt(
        row.token_ciphertext,
        row.key_id,
        aad(row.owner_user_id, row.provider, row.id),
      ),
    ) as StoredTokens;
  }

  private async markReauth(connId: string): Promise<void> {
    await this.db.owner.query(
      `UPDATE connections SET status = 'error', last_error = 'reauth_required', updated_at = now()
        WHERE id = $1 AND status = 'connected'`,
      [connId],
    );
  }

  /**
   * Token dostępu z automatycznym odświeżeniem; wymaga zdolności, jeśli podano. `rejected` = token odrzucony
   * przez API (401) — wymusza odświeżenie, chyba że inny proces już go podmienił.
   */
  async accessToken(
    userId: string,
    provider: Provider,
    cap?: ConnectorCapability,
    opts: { rejected?: string } = {},
  ): Promise<string> {
    const c = this.connector(provider);
    const row = await this.row(userId, provider);
    if (row?.status === 'error' && row.last_error === 'reauth_required')
      throw new ConnectorError('reauth_required', `${provider}: wymagane ponowne połączenie konta`);
    if (!row || row.status !== 'connected')
      throw new ConnectorError('not_connected', `Brak połączenia ${provider}`);
    if (cap && !this.rowAllows(c, row, cap))
      throw new ConnectorError('scope_missing', `Połączenie ${provider} nie obejmuje: ${cap}`);
    const t = this.decode(row);
    if (t.accessToken !== opts.rejected && t.expiresAt - REFRESH_MARGIN_MS > Date.now())
      return t.accessToken;
    try {
      // Odświeżenie pod blokadą wiersza: równoległe zadania nie zużywają tego samego refresh tokenu,
      // a obrócony refresh token (Microsoft) zastępuje poprzedni atomowo.
      return await withSystemTx(this.db, async (tx) => {
        const r = await tx.query<ConnRow>(
          `SELECT * FROM connections WHERE id = $1 AND status = 'connected' FOR UPDATE`,
          [row.id],
        );
        const locked = r.rows[0];
        if (!locked) throw new ConnectorError('not_connected', `Brak połączenia ${provider}`);
        const cur = this.decode(locked);
        if (cur.accessToken !== opts.rejected && cur.expiresAt - REFRESH_MARGIN_MS > Date.now())
          return cur.accessToken;
        if (!cur.refreshToken)
          throw new ConnectorError('reauth_required', 'Brak refresh token — połącz ponownie');
        const fresh = await c.refresh(cur.refreshToken);
        await this.store(tx, locked.id, userId, provider, fresh);
        return fresh.accessToken;
      });
    } catch (err) {
      if (err instanceof ConnectorError && err.code === 'reauth_required')
        await this.markReauth(row.id);
      throw err;
    }
  }

  /**
   * Wywołanie API dostawcy w imieniu użytkownika. Gdy API odrzuci token (401 — np. unieważniony przed
   * czasem), jedno wymuszone odświeżenie i jedno ponowienie; drugie 401 => wymagane ponowne połączenie.
   * Ponowienie jest bezpieczne także dla wysyłki: odrzucone żądanie nie zostało wykonane.
   */
  async call<T>(
    userId: string,
    provider: Provider,
    cap: ConnectorCapability,
    fn: (token: string, c: Connector) => Promise<T>,
  ): Promise<T> {
    const c = this.connector(provider);
    const token = await this.accessToken(userId, provider, cap);
    try {
      return await fn(token, c);
    } catch (err) {
      if (!(err instanceof ConnectorError) || err.code !== 'unauthorized') throw err;
    }
    const fresh = await this.accessToken(userId, provider, cap, { rejected: token });
    try {
      return await fn(fresh, c);
    } catch (err) {
      if (err instanceof ConnectorError && err.code === 'unauthorized') {
        const row = await this.row(userId, provider);
        if (row) await this.markReauth(row.id);
        throw new ConnectorError(
          'reauth_required',
          `${provider}: wymagane ponowne połączenie konta`,
        );
      }
      throw err;
    }
  }

  /** Połączeni dostawcy użytkownika, którzy obsługują zdolność (wybór użytkownika i przyznane zakresy). */
  async capable(userId: string, cap: ConnectorCapability): Promise<Provider[]> {
    if (!this.vault) return [];
    const r = await this.db.owner.query<ConnRow>(
      `SELECT * FROM connections WHERE owner_user_id = $1 AND status = 'connected' ORDER BY provider`,
      [userId],
    );
    return r.rows
      .filter((row) => {
        const c = this.connectors.get(row.provider);
        return !!c && !c.configurationError() && this.rowAllows(c, row, cap);
      })
      .map((row) => row.provider);
  }

  /**
   * Wybór konta dla zdolności: wskazane (musi być połączone) albo jedyne pasujące. Brak konta => czytelny
   * powód (nie połączono / wymagane ponowne połączenie / brak uprawnienia); kilka kont => trzeba wskazać.
   */
  async resolve(userId: string, cap: ConnectorCapability, preferred?: Provider): Promise<Provider> {
    const ok = await this.capable(userId, cap);
    if (preferred ? ok.includes(preferred) : ok.length === 1) return preferred ?? ok[0]!;
    if (!preferred && ok.length > 1)
      throw new ConnectorError(
        'ambiguous_account',
        `Połączono kilka kont z tą funkcją (${ok.join(', ')}) — wskaż konto`,
      );
    const candidates = preferred
      ? [preferred]
      : [...this.connectors.values()]
          .filter((c) => c.capabilities.includes(cap))
          .map((c) => c.provider);
    for (const p of candidates) {
      const row = this.connectors.has(p) ? await this.row(userId, p) : null;
      if (row?.status === 'error' && row.last_error === 'reauth_required')
        throw new ConnectorError('reauth_required', `${p}: wymagane ponowne połączenie konta`);
      if (row?.status === 'connected')
        throw new ConnectorError('scope_missing', `Połączenie ${p} nie obejmuje: ${cap}`);
    }
    throw new ConnectorError('not_connected', `Brak połączonego konta z funkcją ${cap}`);
  }

  /** Etykieta podłączonego konta (np. adres) — do podglądu zgody. */
  async accountLabel(userId: string, provider: Provider): Promise<string | null> {
    return (await this.row(userId, provider))?.account_label ?? null;
  }

  /** Odłączenie: odwołanie u dostawcy (best effort) i usunięcie tokenów z bazy. */
  async disconnect(userId: string, provider: Provider): Promise<boolean> {
    const row = await this.row(userId, provider);
    if (!row) return false;
    const c = this.connectors.get(provider);
    if (c && this.vault && row.token_ciphertext) {
      try {
        const t = this.decode(row);
        await c.revoke(t.refreshToken ?? t.accessToken);
      } catch {
        /* odwołanie u dostawcy nieudane — tokeny i tak usuwamy lokalnie */
      }
    }
    await this.db.owner.query(
      `UPDATE connections SET status = 'revoked', revoked_at = now(), token_ciphertext = NULL, key_id = NULL, updated_at = now() WHERE id = $1`,
      [row.id],
    );
    return true;
  }

  /** Rotacja kluczy: ponowne zaszyfrowanie tokenów bieżącym kluczem głównym. */
  async rotate(): Promise<number> {
    if (!this.vault) return 0;
    const r = await this.db.owner.query<ConnRow>(
      `SELECT * FROM connections WHERE token_ciphertext IS NOT NULL AND key_id IS DISTINCT FROM $1`,
      [this.vault.primaryId],
    );
    for (const row of r.rows) {
      const t = this.decode(row);
      await this.store(this.db.owner, row.id, row.owner_user_id, row.provider, {
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        expiresAt: t.expiresAt,
        scopes: row.scopes,
      });
    }
    return r.rows.length;
  }
}
