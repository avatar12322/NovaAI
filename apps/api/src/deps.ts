import type { AgentRuntime } from './agent/runtime';
import type { AppConfig } from './config';
import type { Db } from './db/pool';
import type { ConnectionService } from './connectors/service';
import type { DeviceBroker } from './devices/broker';
import type { EventHub } from './events';
import type { ModelGateway } from './model/gateway';
import type { CostAdapterRegistry } from './services/adapters';
import type { ToolBroker } from './tools/broker';

/** Zależności aplikacji przekazywane do modułów i kolejki. */
export interface AppDeps {
  config: AppConfig;
  db: Db;
  version: string;
  runtime: AgentRuntime;
  gateway: ModelGateway;
  /** Błąd wczytania konfiguracji modeli (pokazywany w statusie, nie przerywa startu). */
  modelsConfigError: string | null;
  broker: ToolBroker;
  devices: DeviceBroker;
  connections: ConnectionService;
  /** Adaptery raportów kosztów dostawców (klucze tylko w konfiguracji serwera). */
  costAdapters: CostAdapterRegistry;
  events: EventHub;
  /** Budzenie kolejki po utworzeniu zadania (no-op, gdy kolejka wyłączona). */
  kickQueue: () => void;
  /** Stan pętli kolejki w tym procesie (do healthchecka). */
  queueStatus: () => 'running' | 'disabled';
}
