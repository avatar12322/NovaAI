import type { Db } from './db/pool';

/**
 * Sprzątanie wygasłych artefaktów bezpieczeństwa (wyzwania WebAuthn, stany OAuth, kody parowania,
 * tokeny enrolmentu, stare sesje). Uruchamiane okresowo w procesie API.
 */
export async function cleanupExpired(db: Db): Promise<Record<string, number>> {
  const q = async (sql: string) => (await db.owner.query(sql)).rowCount ?? 0;
  return {
    webauthnChallenges: await q(
      `DELETE FROM webauthn_challenges WHERE expires_at < now() - interval '1 hour'`,
    ),
    oauthStates: await q(`DELETE FROM oauth_states WHERE expires_at < now() - interval '1 day'`),
    pairingCodes: await q(
      `DELETE FROM device_pairing_codes WHERE used_at IS NULL AND expires_at < now() - interval '1 day'`,
    ),
    enrollmentTokens: await q(
      `DELETE FROM enrollment_tokens WHERE used_at IS NULL AND expires_at < now() - interval '1 day'`,
    ),
    sessions: await q(
      `DELETE FROM auth_sessions WHERE (expires_at < now() - interval '30 days') OR (revoked_at < now() - interval '30 days')`,
    ),
  };
}

export function startMaintenance(db: Db, everyMs = 3600_000): () => void {
  const run = () => void cleanupExpired(db).catch(() => undefined);
  const first = setTimeout(run, 10_000);
  const iv = setInterval(run, everyMs);
  return () => {
    clearTimeout(first);
    clearInterval(iv);
  };
}
