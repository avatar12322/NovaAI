import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config';
import { withSystemTx, type Db } from '../db/pool';
import { sha256 } from '../lib/crypto';
import {
  ConnectorError,
  type Connector,
  type ConnectorCapability,
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
  connection: {
    status: string;
    scopes: string[];
    updatedAt: string;
    lastError: string | null;
  } | null;
}

const aad = (userId: string, provider: string, connId: string) => `${userId}|${provider}|${connId}`;

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
    readonly unsupported: ReadonlyArray<{ provider: Provider; title: string; reason: string }> = [],
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
        connection: row
          ? {
              status: row.status,
              scopes: row.scopes,
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
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const enc = this.vault!.encrypt(verifier, `oauth|${userId}|${provider}`);
    await this.db.owner.query(
      `INSERT INTO oauth_states (owner_user_id, household_id, provider, state_hash, verifier_cipher, key_id, scopes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        userId,
        householdId,
        provider,
        sha256(state),
        enc.blob,
        enc.keyId,
        scopes,
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
      }>(
        `UPDATE oauth_states SET used_at = now()
          WHERE state_hash = $1 AND provider = $2 AND used_at IS NULL AND expires_at > now()
          RETURNING id, owner_user_id, household_id, verifier_cipher, key_id, scopes`,
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
    const missing = st.scopes.filter((s) => !tokens.scopes.includes(s));
    await withSystemTx(this.db, async (tx) => {
      await tx.query(
        `UPDATE connections SET status = 'revoked', revoked_at = now(), token_ciphertext = NULL
          WHERE owner_user_id = $1 AND provider = $2 AND status <> 'revoked'`,
        [st.owner_user_id, provider],
      );
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO connections (household_id, owner_user_id, provider, status, scopes, last_error)
         VALUES ($1,$2,$3,'connected',$4,$5) RETURNING id`,
        [
          st.household_id,
          st.owner_user_id,
          provider,
          tokens.scopes,
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

  /** Token dostępu z automatycznym odświeżeniem; wymaga zakresu, jeśli podano. */
  async accessToken(userId: string, provider: Provider, requiredScope?: string): Promise<string> {
    const c = this.connector(provider);
    const row = await this.row(userId, provider);
    if (!row || row.status !== 'connected')
      throw new ConnectorError('not_connected', `Brak połączenia ${provider}`);
    if (requiredScope && !row.scopes.includes(requiredScope))
      throw new ConnectorError('scope_missing', `Brak zakresu ${requiredScope}`);
    const t = this.decode(row);
    if (t.expiresAt - REFRESH_MARGIN_MS > Date.now()) return t.accessToken;
    if (!t.refreshToken)
      throw new ConnectorError('reauth_required', 'Brak refresh token — połącz ponownie');
    try {
      const fresh = await c.refresh(t.refreshToken);
      await this.store(this.db.owner, row.id, userId, provider, fresh);
      return fresh.accessToken;
    } catch (err) {
      if (err instanceof ConnectorError && err.code === 'reauth_required') {
        await this.db.owner.query(
          `UPDATE connections SET status = 'error', last_error = 'reauth_required', updated_at = now() WHERE id = $1`,
          [row.id],
        );
      }
      throw err;
    }
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

  /** Połączenie z danym zakresem (do wyboru źródła free/busy). */
  async hasScope(userId: string, provider: Provider, scope: string): Promise<boolean> {
    if (!this.connectors.has(provider) || !this.vault) return false;
    const row = await this.row(userId, provider);
    return !!row && row.status === 'connected' && row.scopes.includes(scope);
  }
}
