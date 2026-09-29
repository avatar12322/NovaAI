/**
 * Prognoza pogody z Open-Meteo (open-meteo.com): bez klucza, bezpłatnie do użytku niekomercyjnego
 * (limit 10 000 zapytań dziennie), dane na licencji CC BY 4.0 — źródło podawane w aplikacji.
 * Do serwisu trafiają wyłącznie współrzędne miasta ustawionego przez właściciela domu.
 */
export interface DayWeather {
  /** YYYY-MM-DD (czas polski). */
  date: string;
  code: number;
  min: number;
  max: number;
  /** Szansa opadów w % (null — brak danych). */
  rain: number | null;
}

export interface Place {
  place: string;
  latitude: number;
  longitude: number;
}

export const WEATHER_ATTRIBUTION = 'Pogoda: Open-Meteo.com (CC BY 4.0)';
const CACHE_MS = 30 * 60_000;

/** Kody WMO → opis po polsku. */
export function weatherLabel(code: number): string {
  if (code === 0) return 'bezchmurnie';
  if (code === 1) return 'przeważnie słonecznie';
  if (code === 2) return 'częściowe zachmurzenie';
  if (code === 3) return 'pochmurno';
  if (code === 45 || code === 48) return 'mgła';
  if (code >= 51 && code <= 57) return 'mżawka';
  if (code >= 61 && code <= 67) return 'deszcz';
  if (code >= 71 && code <= 77) return 'śnieg';
  if (code >= 80 && code <= 82) return 'przelotne opady deszczu';
  if (code === 85 || code === 86) return 'przelotne opady śniegu';
  if (code >= 95) return 'burza';
  return 'zmienna pogoda';
}

/** „9–14°C, deszcz, szansa opadów 70%”. */
export function weatherText(w: DayWeather): string {
  const t = `${Math.round(w.min)}–${Math.round(w.max)}°C`;
  const rain = w.rain !== null && w.rain >= 30 ? `, szansa opadów ${Math.round(w.rain)}%` : '';
  return `${t}, ${weatherLabel(w.code)}${rain}`;
}

export class OpenMeteo {
  private cache = new Map<string, { at: number; days: DayWeather[] }>();

  constructor(
    private readonly base = 'https://api.open-meteo.com',
    private readonly geoBase = 'https://geocoding-api.open-meteo.com',
  ) {}

  /** Prognoza na dziś i jutro (czas polski); wynik buforowany 30 min. */
  async forecast(latitude: number, longitude: number): Promise<DayWeather[]> {
    const key = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.days;
    const url = new URL('/v1/forecast', this.base);
    url.searchParams.set('latitude', String(latitude));
    url.searchParams.set('longitude', String(longitude));
    url.searchParams.set(
      'daily',
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    );
    url.searchParams.set('timezone', 'Europe/Warsaw');
    url.searchParams.set('forecast_days', '2');
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const body = (await res.json()) as {
      daily?: {
        time?: string[];
        weather_code?: number[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_probability_max?: (number | null)[];
      };
    };
    const d = body.daily ?? {};
    const days: DayWeather[] = (d.time ?? []).flatMap((date, i) => {
      const code = d.weather_code?.[i];
      const max = d.temperature_2m_max?.[i];
      const min = d.temperature_2m_min?.[i];
      if (typeof code !== 'number' || typeof max !== 'number' || typeof min !== 'number') return [];
      const rain = d.precipitation_probability_max?.[i];
      return [{ date, code, min, max, rain: typeof rain === 'number' ? rain : null }];
    });
    this.cache.set(key, { at: Date.now(), days });
    return days;
  }

  /** Wyszukanie miasta (pierwszy wynik) — do ustawienia miejsca prognozy. */
  async geocode(name: string): Promise<Place | null> {
    const url = new URL('/v1/search', this.geoBase);
    url.searchParams.set('name', name);
    url.searchParams.set('count', '1');
    url.searchParams.set('language', 'pl');
    url.searchParams.set('format', 'json');
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`open-meteo geocoding ${res.status}`);
    const body = (await res.json()) as {
      results?: Array<{
        name?: string;
        latitude?: number;
        longitude?: number;
        admin1?: string;
        country?: string;
      }>;
    };
    const r = body.results?.[0];
    if (!r || typeof r.latitude !== 'number' || typeof r.longitude !== 'number' || !r.name)
      return null;
    const place = [r.name, r.admin1 && r.admin1 !== r.name ? r.admin1 : null, r.country]
      .filter(Boolean)
      .join(', ');
    return { place: place.slice(0, 120), latitude: r.latitude, longitude: r.longitude };
  }
}
