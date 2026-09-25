import type { AgentRuntime } from './agent/runtime';
import type { AppConfig } from './config';
import type { Db } from './db/pool';
import type { DeviceBroker } from './devices/broker';
import type { EventHub } from './events';
import type { ModelGateway } from './model/gateway';
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
  events: EventHub;
  /** Budzenie kolejki po utworzeniu zadania (no-op, gdy kolejka wyłączona). */
  kickQueue: () => void;
  /** Stan pętli kolejki w tym procesie (do healthchecka). */
  queueStatus: () => 'running' | 'disabled';
}
