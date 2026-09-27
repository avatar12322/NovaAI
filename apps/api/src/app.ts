import { FakeAgentRuntime } from './agent/fake-runtime';
import type { AgentRuntime } from './agent/runtime';
import type { AppConfig } from './config';
import type { Db } from './db/pool';
import type { AppDeps } from './deps';
import { GoogleConnector, type GoogleEndpoints } from './connectors/google';
import {
  MicrosoftConnector,
  microsoftEndpoints,
  type MicrosoftEndpoints,
} from './connectors/microsoft';
import { ConnectionService } from './connectors/service';
import type { Connector, Provider } from './connectors/types';
import { SlackConnector, type SlackEndpoints } from './connectors/slack';
import { SLACK_TOOLS } from './connectors/slack-tools';
import { calendarAgendaTool } from './calendar/tools';
import type { ToolDef } from './tools/types';
import { CONNECTOR_TOOLS } from './connectors/tools';
import { vaultFromEnv } from './connectors/vault';
import { createCostAdapters } from './services/adapters';
import { DeviceBroker } from './devices/broker';
import { reminderFireKind } from './reminders/service';
import { documentIndexKind } from './documents/service';
import { DOCUMENT_TOOLS } from './documents/tools';
import { reminderCreateTool } from './reminders/tool';
import { DeviceHub } from './devices/hub';
import { deviceSigningKey } from './devices/keys';
import { DEVICE_TOOLS } from './devices/tools';
import { emitEvent, EventHub } from './events';
import { LiveHub } from './live';
import { ElevenLabsStt, ElevenLabsTts } from './voice/elevenlabs';
import { ModelAgentRuntime } from './model/agent-runtime';
import { AutoAgentRuntime } from './model/auto-runtime';
import { loadModelsConfig, type ModelsConfig } from './model/config';
import { ModelGateway } from './model/gateway';
import { DbHouseholdModels } from './model/household';
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
  /** Adresy Google (testy kontraktowe na lokalnym mocku). */
  googleEndpoints?: GoogleEndpoints;
  /** Adresy Microsoft identity platform i Graph (testy kontraktowe na lokalnym mocku). */
  microsoftEndpoints?: MicrosoftEndpoints;
  /** Adresy Slack OAuth i Web API (testy kontraktowe na lokalnym mocku). */
  slackEndpoints?: SlackEndpoints;
  /** Adresy API raportów kosztów (testy kontraktowe na lokalnym mocku). */
  costAdapterBases?: { anthropic?: string; openai?: string };
  /** Adres API ElevenLabs (testy kontraktowe na lokalnym mocku). */
  ttsBase?: string;
  version?: string;
  demoStepMs?: number;
  runnerWorkerId?: string;
  retryBaseMs?: number;
}

interface App {
  deps: AppDeps;
  runner: TaskRunner;
  /** Klucz publiczny serwera do podpisu poleceń (przypinany przez Workery). */
  deviceServerPublicKey: Buffer;
}

/** Składa zależności aplikacji: broker z narzędziami, runtime, hub zdarzeń, kolejkę. */
export function createApp(config: AppConfig, db: Db, opts: AppOptions = {}): App {
  const broker = new ToolBroker().register(memoryCreateTool).register(householdNotifyTool);
  for (const t of DEVICE_TOOLS) broker.register(t);
  for (const t of CONNECTOR_TOOLS) broker.register(t);
  for (const t of SLACK_TOOLS) broker.register(t);
  for (const t of DOCUMENT_TOOLS) broker.register(t);
  broker.register(calendarAgendaTool as unknown as ToolDef);
  broker.register(reminderCreateTool);
  const vault = vaultFromEnv(config.secretKey, config.secretKeyId, config.secretKeysOld);
  const connections = new ConnectionService(
    db,
    config,
    vault,
    new Map<Provider, Connector>([
      [
        'google',
        new GoogleConnector(
          config.google.clientId,
          config.google.clientSecret,
          opts.googleEndpoints,
        ),
      ],
      [
        'microsoft',
        new MicrosoftConnector(
          config.microsoft.clientId,
          config.microsoft.clientSecret,
          opts.microsoftEndpoints ?? microsoftEndpoints(config.microsoft.tenant),
        ),
      ],
      [
        'slack',
        new SlackConnector(config.slack.clientId, config.slack.clientSecret, opts.slackEndpoints),
      ],
    ]),
  );
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
  // Dostawcy i modele dodani w aplikacji (klucze zaszyfrowane NOVA_SECRET_KEY) — per dom, bez restartu.
  gateway.useHouseholdSource(new DbHouseholdModels(db, vault, config.modelsAllowLocal));
  // Bez żadnego dostępnego modelu dla domu działa jawny tryb demo (deterministyczny, bez kosztów).
  const runtime =
    opts.runtime ??
    new AutoAgentRuntime(gateway, new ModelAgentRuntime(gateway, broker), new FakeAgentRuntime());
  const deps: AppDeps = {
    config,
    db,
    version: opts.version ?? 'dev',
    runtime,
    gateway,
    vault,
    modelsConfigError: loaded.error,
    broker,
    devices,
    connections,
    costAdapters: createCostAdapters(config.costAdapterKeys, opts.costAdapterBases),
    events,
    live: new LiveHub(),
    tts: config.tts.apiKey
      ? new ElevenLabsTts({
          apiKey: config.tts.apiKey,
          voiceId: config.tts.voiceId,
          modelId: config.tts.modelId,
          baseUrl: opts.ttsBase,
        })
      : null,
    stt:
      config.tts.apiKey && config.stt.monthlyMinutes > 0
        ? new ElevenLabsStt({
            apiKey: config.tts.apiKey,
            modelId: config.stt.modelId,
            baseUrl: opts.ttsBase,
          })
        : null,
    kickQueue: () => undefined,
    queueStatus: () => 'disabled',
  };
  const runner = new TaskRunner(deps, {
    leaseMs: config.queueLeaseMs,
    workerId: opts.runnerWorkerId,
    retryBaseMs: opts.retryBaseMs,
  })
    .registerKind('agent.turn', agentTurnKind)
    .registerKind('demo.workflow', demoWorkflowKind(opts.demoStepMs ?? 400))
    .registerKind('reminder.fire', reminderFireKind)
    .registerKind('document.index', documentIndexKind);
  if (config.queueEnabled) deps.kickQueue = () => runner.kick();
  deps.queueStatus = () => (runner.isRunning ? 'running' : 'disabled');
  return { deps, runner, deviceServerPublicKey: signing.publicRaw };
}
