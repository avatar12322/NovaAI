import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../access';
import { writeAudit } from '../audit';
import type { AppDeps } from '../deps';
import { badRequest, forbidden } from '../lib/errors';
import { parse } from '../lib/validate';

const Money = z.number().min(0).max(1_000_000).nullable();
const UpdateBudget = z.object({
  softLimit: Money,
  hardLimit: Money,
  paidCallsEnabled: z.boolean(),
});

export const budgetRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/budget', async (req) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      return deps.gateway.budget.status(auth.householdId);
    });

    /** Ustawienia budżetu domu: każdy aktywny domownik; zmiana audytowana i widoczna dla obojga. */
    app.put('/budget', async (req) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      const body = parse(UpdateBudget, req.body);
      if (body.softLimit !== null && body.hardLimit !== null && body.softLimit > body.hardLimit) {
        throw badRequest('Próg ostrzeżenia nie może przekraczać twardego limitu');
      }
      await deps.gateway.budget.update(auth.householdId, auth.userId, body);
      await writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: auth.userId,
        ownerUserId: auth.userId,
        householdId: auth.householdId,
        source: 'api',
        action: 'budget.update',
        resourceType: 'budget',
        resourceId: auth.householdId,
        outcome: 'ok',
        correlationId: req.id,
        details: body,
      });
      return deps.gateway.budget.status(auth.householdId);
    });

    /** Stan modeli bez sekretów: tryb, dostępność i powód niedostępności. */
    app.get('/model/status', async (req) => {
      requireAuth(req);
      const s = deps.gateway.status();
      return {
        mode: s.mode,
        runtime: deps.runtime.name,
        currency: s.currency,
        configError: deps.modelsConfigError,
        providers: s.models.map((m) => ({
          name: `${m.key} (${m.provider}/${m.model})`,
          kind: m.provider,
          configured: m.available,
          reason: m.reason,
          paid: m.paid,
          pricingVerified: m.pricingVerified,
        })),
      };
    });
  };
