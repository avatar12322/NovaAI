import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireOwner } from '../access';
import { writeAudit } from '../audit';
import type { AppDeps } from '../deps';
import { badRequest, forbidden, HttpError } from '../lib/errors';
import { RateLimiter } from '../lib/rate-limit';
import { parse } from '../lib/validate';
import { WEATHER_ATTRIBUTION } from '../weather/openmeteo';
import { buildDigest } from './service';

/** Ustawienia przeglądów dnia (każdy dla siebie) i miejsce prognozy pogody (właściciel domu). */
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Godzina w formacie GG:MM');
const Settings = z.object({
  morning: z.boolean(),
  morningAt: HHMM,
  evening: z.boolean(),
  eveningAt: HHMM,
});
const Weather = z.object({ place: z.string().trim().min(2).max(80) });

export const digestRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const geoLimiter = new RateLimiter(10, 60_000);
    const member = (req: FastifyRequest) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      return { ...auth, householdId: auth.householdId };
    };

    app.get('/digest/settings', async (req) => {
      const auth = member(req);
      const s = await deps.db.owner.query<{
        morning: boolean;
        morning_at: string;
        evening: boolean;
        evening_at: string;
      }>(
        `SELECT morning, to_char(morning_at, 'HH24:MI') AS morning_at,
                evening, to_char(evening_at, 'HH24:MI') AS evening_at
           FROM digest_settings WHERE user_id = $1`,
        [auth.userId],
      );
      const w = await deps.db.owner.query<{ place: string }>(
        'SELECT place FROM household_weather WHERE household_id = $1',
        [auth.householdId],
      );
      const row = s.rows[0];
      return {
        morning: row?.morning ?? true,
        morningAt: row?.morning_at ?? '07:00',
        evening: row?.evening ?? true,
        eveningAt: row?.evening_at ?? '22:00',
        weatherPlace: w.rows[0]?.place ?? null,
        canSetWeather: auth.householdRole === 'owner',
        attribution: WEATHER_ATTRIBUTION,
      };
    });

    app.put('/digest/settings', async (req) => {
      const auth = member(req);
      const b = parse(Settings, req.body);
      await deps.db.owner.query(
        `INSERT INTO digest_settings (user_id, morning, morning_at, evening, evening_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE SET morning = $2, morning_at = $3, evening = $4,
           evening_at = $5, updated_at = now()`,
        [auth.userId, b.morning, b.morningAt, b.evening, b.eveningAt],
      );
      return b;
    });

    /** Podgląd treści przeglądu (rano: dziś, wieczorem: jutro) — bez wysyłki. */
    app.get('/digest/preview', async (req) => {
      const auth = member(req);
      const kind = (req.query as { kind?: string }).kind === 'evening' ? 'evening' : 'morning';
      return buildDigest(deps, auth, kind);
    });

    app.put('/household/weather', async (req) => {
      const auth = requireOwner(req, 'Miejsce prognozy pogody');
      const { place } = parse(Weather, req.body);
      if (!geoLimiter.hit(auth.userId))
        throw new HttpError(429, 'rate_limited', 'Zbyt wiele wyszukiwań — spróbuj za chwilę');
      let found;
      try {
        found = await deps.weather.geocode(place);
      } catch {
        throw new HttpError(502, 'weather_unavailable', 'Usługa pogody jest chwilowo niedostępna');
      }
      if (!found) throw badRequest(`Nie znaleziono miejscowości „${place}”`);
      await deps.db.owner.query(
        `INSERT INTO household_weather (household_id, place, latitude, longitude)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (household_id) DO UPDATE SET place = $2, latitude = $3, longitude = $4,
           updated_at = now()`,
        [auth.householdId, found.place, found.latitude, found.longitude],
      );
      await writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: auth.userId,
        ownerUserId: auth.userId,
        householdId: auth.householdId,
        source: 'api',
        action: 'household.weather_place',
        resourceType: 'household',
        resourceId: auth.householdId,
        outcome: 'ok',
        correlationId: req.id,
      });
      return { weatherPlace: found.place };
    });

    app.delete('/household/weather', async (req) => {
      const auth = requireOwner(req, 'Miejsce prognozy pogody');
      await deps.db.owner.query('DELETE FROM household_weather WHERE household_id = $1', [
        auth.householdId,
      ]);
      return { weatherPlace: null };
    });
  };
