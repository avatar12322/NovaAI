/**
 * Przepisy z aniagotuje.pl: wyszukiwarka serwisu (`/szukaj?s=`) i składniki z oznaczeń schema.org Recipe
 * (`itemprop="recipeIngredient"` — tekst albo `<meta content>`). Serwer łączy się tylko z tym serwisem
 * (adres stały, bez podążania za przekierowaniami), a do modelu trafia wyłącznie lista składników.
 */
export const RECIPE_SITE = 'https://aniagotuje.pl';
const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

export interface RecipeHit {
  slug: string;
  title: string;
}

export interface Recipe {
  slug: string;
  url: string;
  title: string;
  yield: string;
  ingredients: string[];
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Tekst z fragmentu HTML: bez znaczników, encje zdekodowane, pojedyncze spacje. */
const text = (html: string) =>
  decode(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Link do przepisu podany przez użytkownika → identyfikator przepisu (tylko aniagotuje.pl). */
export function slugFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/^(www\.)?aniagotuje\.pl$/.test(u.hostname)) return null;
  const m = /^\/przepis\/([^/]+)\/?$/.exec(u.pathname);
  return m && SLUG.test(m[1]!) ? m[1]! : null;
}

/** Wyniki wyszukiwarki: tytuły przepisów w kolejności serwisu, bez powtórzeń. */
export function parseSearch(html: string): RecipeHit[] {
  const out: RecipeHit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<a href="\/przepis\/([a-z0-9-]+)"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>/g,
  )) {
    const slug = m[1]!;
    if (seen.has(slug) || !SLUG.test(slug)) continue;
    seen.add(slug);
    out.push({ slug, title: text(m[2]!) });
  }
  return out;
}

/** Tytuł, porcja i składniki ze strony przepisu; null — strona bez oznaczeń przepisu. */
export function parseRecipe(html: string, slug: string): Recipe | null {
  const ingredients: string[] = [];
  const tag = /<(meta|span)\b[^>]*itemprop="recipeIngredient"[^>]*>/g;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    let value: string;
    if (m[1] === 'meta') {
      value = decode(/\bcontent="([^"]*)"/.exec(m[0])?.[1] ?? '');
    } else {
      // Tekst składnika: do końca pozycji listy albo do rozbicia na pojedyncze składniki (<meta>).
      const rest = html.slice(tag.lastIndex, tag.lastIndex + 2000);
      const end = rest.search(/<\/li>|<meta\b/);
      value = text(end >= 0 ? rest.slice(0, end) : rest);
    }
    value = value.replace(/\s+/g, ' ').trim();
    if (value) ingredients.push(value.slice(0, 200));
  }
  if (!ingredients.length) return null;
  const title = text(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '') || slug;
  const recipeYield = decode(/itemprop="recipeYield" content="([^"]*)"/.exec(html)?.[1] ?? '');
  return {
    slug,
    url: `${RECIPE_SITE}/przepis/${slug}`,
    title: title.slice(0, 200),
    yield: recipeYield.slice(0, 200),
    ingredients: ingredients.slice(0, 80),
  };
}

const STAPLES = new Set([
  'woda',
  'wody',
  'wodą',
  'wodę',
  'wodzie',
  'sól',
  'soli',
  'solą',
  'pieprz',
  'pieprzu',
  'pieprzem',
]);

/** Woda, sól i pieprz — zwykle są w domu, więc nie trafiają na listę zakupów. */
export function isStaple(ingredient: string): boolean {
  return ingredient
    .toLocaleLowerCase('pl-PL')
    .split(/[^\p{L}]+/u)
    .some((w) => STAPLES.has(w));
}

export class RecipeSource {
  constructor(private readonly base = RECIPE_SITE) {}

  private async get(path: string): Promise<string | null> {
    const res = await fetch(`${this.base}${path}`, {
      headers: { 'user-agent': 'NovaAI (asystent domowy)', accept: 'text/html' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`aniagotuje.pl: HTTP ${res.status}`);
    const body = await res.text();
    return body.length > MAX_BYTES ? body.slice(0, MAX_BYTES) : body;
  }

  async search(query: string): Promise<RecipeHit[]> {
    const html = await this.get(`/szukaj?s=${encodeURIComponent(query.trim().slice(0, 100))}`);
    return html ? parseSearch(html) : [];
  }

  async recipe(slug: string): Promise<Recipe | null> {
    if (!SLUG.test(slug)) return null;
    const html = await this.get(`/przepis/${slug}`);
    return html ? parseRecipe(html, slug) : null;
  }
}
