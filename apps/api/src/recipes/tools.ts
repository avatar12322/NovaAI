import { z } from 'zod';
import { ToolDenied, type ToolDef } from '../tools/types';
import { isStaple, slugFromUrl } from './aniagotuje';

type FindParams = { dish?: string; url?: string };

/**
 * „Chcę zrobić leczo” → przepis z aniagotuje.pl (nazwa dania albo link) → składniki dla modelu, który
 * w turze uzupełniającej proponuje listę zakupów (zawsze ze zgodą). Woda, sól i pieprz są pomijane.
 */
export const recipeFindTool: ToolDef<FindParams> = {
  name: 'recipe.find',
  capability: 'recipe.find',
  title:
    'Znajdź przepis na aniagotuje.pl i pobierz jego składniki: dish — nazwa dania po polsku (np. „leczo”, „naleśniki”) albo url — link do przepisu na aniagotuje.pl. Używaj, gdy użytkownik pisze, co chce zjeść lub ugotować. Po wyniku zaproponujesz shopping.add ze składnikami (zgoda użytkownika)',
  contexts: ['private_agent', 'household_agent'],
  readOnly: true,
  followUpTools: ['shopping.add'],
  params: z
    .object({
      dish: z.string().trim().min(2).max(100).optional(),
      url: z.string().trim().max(300).optional(),
    })
    .refine((p) => p.dish || p.url, 'dish albo url') as unknown as z.ZodType<FindParams>,
  requiresApproval: () => false,
  async preview(_ctx, p) {
    return { summary: `Przepis: ${p.dish ?? p.url}`, target: 'aniagotuje.pl', scope: 'odczyt' };
  },
  // Serwer łączy się tylko z aniagotuje.pl — inny link odrzucony przy planowaniu.
  async authorize(_ctx, p) {
    return p.url && !slugFromUrl(p.url)
      ? { allow: false, reason: 'not_aniagotuje_url' }
      : { allow: true, reason: 'public_recipe' };
  },
  async execute(ctx, p) {
    const src = ctx.deps.recipes;
    let slug = p.url ? slugFromUrl(p.url) : null;
    if (p.url && !slug) throw new ToolDenied('not_aniagotuje_url');
    const hits = slug ? [] : await src.search(p.dish!);
    slug ??= hits[0]?.slug ?? null;
    const recipe = slug ? await src.recipe(slug) : null;
    if (!recipe) {
      return {
        summary: `Nie znaleziono przepisu na aniagotuje.pl: ${p.dish ?? p.url}`,
        output: { lines: ['Przepisu nie ma na aniagotuje.pl — możesz użyć własnej wiedzy.'] },
      };
    }
    const toBuy = recipe.ingredients.filter((i) => !isStaple(i));
    const skipped = recipe.ingredients.filter((i) => isStaple(i));
    const others = hits.slice(1, 4).map((h) => h.title);
    return {
      summary: `Przepis: ${recipe.title} (aniagotuje.pl)`,
      output: {
        lines: [
          `${recipe.title} — ${recipe.url}`,
          ...(recipe.yield ? [`Ilość z przepisu: ${recipe.yield}`] : []),
          'Składniki do kupienia:',
          ...toBuy.map((i) => `- ${i}`),
          ...(skipped.length ? [`Pominięte (zwykle w domu): ${skipped.join('; ')}`] : []),
          ...(others.length ? [`Inne przepisy w serwisie: ${others.join('; ')}`] : []),
        ],
      },
    };
  },
};
