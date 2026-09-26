import type {
  AgentRuntime,
  AgentTurnInput,
  AgentTurnResult,
  AgentUserContext,
} from '../agent/runtime';
import type { ModelGateway } from './gateway';

/**
 * Wybór runtime per tura: jeśli dom ma dostępny model (plik konfiguracyjny albo dostawca dodany w aplikacji),
 * odpowiada model; inaczej jawny tryb demo. Dodanie lub usunięcie klucza działa bez restartu serwera.
 */
export class AutoAgentRuntime implements AgentRuntime {
  readonly name = 'auto';

  constructor(
    private readonly gateway: ModelGateway,
    private readonly model: AgentRuntime,
    private readonly demo: AgentRuntime,
  ) {}

  async resolveFor(householdId: string | null): Promise<AgentRuntime> {
    const snap = await this.gateway.snapshot(householdId);
    return snap.hasAvailable() ? this.model : this.demo;
  }

  async runTurn(
    input: AgentTurnInput,
    ctx: AgentUserContext,
    allowedCapabilities: readonly string[],
  ): Promise<AgentTurnResult> {
    const runtime = await this.resolveFor(ctx.householdId);
    return runtime.runTurn(input, ctx, allowedCapabilities);
  }
}
