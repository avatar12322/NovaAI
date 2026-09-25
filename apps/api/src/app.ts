import { FakeAgentRuntime } from './agent/fake-runtime';
import type { AgentRuntime } from './agent/runtime';
import type { AppConfig } from './config';
import type { Db } from './db/pool';
import type { AppDeps } from './deps';
import { DeviceBroker } from './devices/broker';
import { DeviceHub } from './devices/hub';
import { deviceSigningKey } from './devices/keys';
import { DEVICE_TOOLS } from './devices/tools';
import { emitEvent, EventHub } from './events';
import { ModelAgentRuntime } from './model/agent-runtime';
import { loadModelsConfig, type ModelsConfig } from './model/config';
import { ModelGateway } from './model/gateway';
import type { ModelProvider } from './model/types';
import { agentTurnKind, demoWorkflowKind } from './queue/kinds';
import { TaskRunner } from './queue/runner';
import { ToolBroker } from './tools/broker';
import { householdNotifyTool, memoryCreateTool } from './tools/builtin';

export interface AppOptions {
  runtime?: AgentRuntime;
  /** Konfiguracja modeli (domyślnie z NOVA_MODELS_CONFIG). */
  modelsConfig?: ModelsConfig;
  /** Podmiana dostawców (testy kontraktowe / fake). */
  providerOverrides?: Record<string, ModelProvider>;
  env?: NodeJS.ProcessEnv;
  version?: string;
  demoStepMs?: number;
  runnerWorkerId?: string;
  retryBaseMs?: number;
}

export interface App {
  deps: AppDeps;
  runner: TaskRunner;
  /** Klucz publiczny serwera do podpisu poleceń (przypinany przez Workery). */
  deviceServerPublicKey: Buffer;
}

/** Składa zależności aplikacji: broker z narzędziami, runtime, hub zdarzeń, kolejkę. */
export function createApp(config: AppConfig, db: Db, opts: AppOptions = {}): App {
  const broker = new ToolBroker().register(memoryCreateTool).register(householdNotifyTool);
  for (const t of DEVICE_TOOLS) broker.register(t);
  const signing = deviceSigningKey(config);
  const hub = new DeviceHub(signing.key, (deviceId, ownerUserId, online) => {
    // Status urządzenia jest prywatny dla właściciela.
    void db.owner
      .query<{ household_id: string }>('SELECT household_id FROM devices WHERE id = $1', [deviceId])
      .then((r) =>
        r.rows[0]
          ? emitEvent(db.owner, {
              householdId: r.rows[0].household_id,
              ownerUserId,
              visibility: 'private',
              type: 'device.status',
              payload: { deviceId, online },
            })
          : undefined,
      )
      .catch(() => undefined);
  });
  const devices = new DeviceBroker(db, hub);
  const events = new EventHub(db);
  const loaded = opts.modelsConfig
    ? { config: opts.modelsConfig, error: null }
    : loadModelsConfig(config.modelsConfigPath);
  const gateway = new ModelGateway(
    db,
    loaded.config,
    opts.env ?? process.env,
    opts.providerOverrides,
  );
  // Bez żadnego dostępnego modelu działa jawny tryb demo (deterministyczny, bez kosztów).
  const runtime =
    opts.runtime ??
    (gateway.hasAvailable() ? new ModelAgentRuntime(gateway, broker) : new FakeAgentRuntime());
  const deps: AppDeps = {
    config,
    db,
    version: opts.version ?? 'dev',
    runtime,
    gateway,
    modelsConfigError: loaded.error,
    broker,
    devices,
    events,
    kickQueue: () => undefined,
    queueStatus: () => 'disabled',
  };
  const runner = new TaskRunner(deps, {
    leaseMs: config.queueLeaseMs,
    workerId: opts.runnerWorkerId,
    retryBaseMs: opts.retryBaseMs,
  })
    .registerKind('agent.turn', agentTurnKind)
    .registerKind('demo.workflow', demoWorkflowKind(opts.demoStepMs ?? 400));
  if (config.queueEnabled) deps.kickQueue = () => runner.kick();
  deps.queueStatus = () => (runner.isRunning ? 'running' : 'disabled');
  return { deps, runner, deviceServerPublicKey: signing.publicRaw };
}
