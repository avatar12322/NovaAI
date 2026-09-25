import type { AgentRuntime } from './agent/runtime';
import type { AppConfig } from './config';
import type { Db } from './db/pool';

/**
 * Zależności aplikacji przekazywane do modułów. Rozszerzane w kolejnych etapach
 * (kolejka, broker narzędzi, broker urządzeń).
 */
export interface AppDeps {
  config: AppConfig;
  db: Db;
  version: string;
  runtime: AgentRuntime;
}
