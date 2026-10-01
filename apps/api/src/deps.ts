import type { AgentRuntime } from './agent/runtime';
import type { AppConfig } from './config';
import type { Db } from './db/pool';
import type { ConnectionService } from './connectors/service';
import type { Vault } from './connectors/vault';
import type { DeviceBroker } from './devices/broker';
import type { EventHub } from './events';
import type { LiveHub } from './live';
import type { PushService } from './push/service';
import type { OpenMeteo } from './weather/openmeteo';
import type { RecipeSource } from './recipes/aniagotuje';
import type { TransitSource } from './transit/source';
import type { ElevenLabsStt, ElevenLabsTts } from './voice/elevenlabs';
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
  /** Szyfrowanie sekretów (NOVA_SECRET_KEY); null => sekretów nie da się zapisać. */
  vault: Vault | null;
  /** Błąd wczytania konfiguracji modeli (pokazywany w statusie, nie przerywa startu). */
  modelsConfigError: string | null;
  broker: ToolBroker;
  devices: DeviceBroker;
  connections: ConnectionService;
  /** Adaptery raportów kosztów dostawców (klucze tylko w konfiguracji serwera). */
  costAdapters: CostAdapterRegistry;
  events: EventHub;
  /** Zdarzenia ulotne (tekst odpowiedzi na żywo) — bez zapisu w bazie. */
  live: LiveHub;
  /** Głos ElevenLabs (null bez klucza — wtedy głos przeglądarki). */
  tts: ElevenLabsTts | null;
  /** Rozpoznawanie mowy ElevenLabs — zapas dla przeglądarek bez rozpoznawania mowy (null: wyłączone). */
  stt: ElevenLabsStt | null;
  /** Powiadomienia push na urządzeniach (Web Push). */
  push: PushService;
  /** Prognoza pogody (Open-Meteo) do przeglądów dnia. */
  weather: OpenMeteo;
  /** Przepisy z aniagotuje.pl (składniki do listy zakupów). */
  recipes: RecipeSource;
  /** Rozkłady jazdy (pociągi, autobusy KM) i opóźnienia na żywo. */
  transit: TransitSource;
  /** Budzenie kolejki po utworzeniu zadania (no-op, gdy kolejka wyłączona). */
  kickQueue: () => void;
  /** Stan pętli kolejki w tym procesie (do healthchecka). */
  queueStatus: () => 'running' | 'disabled';
}
