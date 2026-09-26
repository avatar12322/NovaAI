import { ToolDenied } from '../tools/types';
import { ConnectorError } from './types';

/**
 * Błąd connectora w narzędziu: przejściowy (limit zapytań, brak sieci) — wyjątek bez zmian, zadanie ponowi krok;
 * trwały — odmowa z czytelnym powodem `connector:<powód>` (np. `connector:not_in_channel`).
 */
export function mapErr(err: unknown): never {
  if (err instanceof ConnectorError) {
    if (err.retryable) throw err;
    throw new ToolDenied(`connector:${err.reason ?? err.code}`);
  }
  throw err;
}
