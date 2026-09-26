import type { Route } from './router';

/** Polecenie palety: przejście do widoku albo akcja. */
export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  keywords: string;
  run:
    { route: Route } | { action: 'new-chat' | 'ask' | 'briefing' | 'theme-light' | 'theme-dark' };
}

export const COMMANDS: Command[] = [
  {
    id: 'chat',
    label: 'Czat prywatny',
    icon: 'chat',
    keywords: 'czat rozmowa prywatny asystent',
    run: { route: { view: 'chat', space: 'private', id: null } },
  },
  {
    id: 'shared',
    label: 'NovaAI (wspólne)',
    icon: 'users',
    keywords: 'novaai wspólne dom rozmowa',
    run: { route: { view: 'chat', space: 'shared', id: null } },
  },
  {
    id: 'new-chat',
    label: 'Nowa rozmowa',
    icon: 'plus',
    keywords: 'nowa rozmowa czat',
    run: { action: 'new-chat' },
  },
  {
    id: 'home',
    label: 'Dom i przegląd dnia',
    icon: 'home',
    keywords: 'dom przegląd dzień dzisiaj powitanie',
    run: { route: { view: 'home' } },
  },
  {
    id: 'briefing',
    label: 'Przeczytaj przegląd dnia',
    icon: 'speaker',
    keywords: 'przegląd dzień przeczytaj głos',
    run: { action: 'briefing' },
  },
  {
    id: 'tasks',
    label: 'Zadania',
    icon: 'tasks',
    keywords: 'zadania kolejka postęp',
    run: { route: { view: 'tasks', id: null } },
  },
  {
    id: 'approvals',
    label: 'Zgody',
    icon: 'shield',
    keywords: 'zgody akceptacja zatwierdź',
    run: { route: { view: 'approvals' } },
  },
  {
    id: 'memory',
    label: 'Pamięć',
    icon: 'memory',
    keywords: 'pamięć zapamiętane fakty',
    run: { route: { view: 'memory', space: 'private' } },
  },
  {
    id: 'documents',
    label: 'Dokumenty',
    icon: 'doc',
    keywords: 'dokumenty pliki pdf cv umowy',
    run: { route: { view: 'documents', space: 'private' } },
  },
  {
    id: 'services',
    label: 'Usługi i koszty',
    icon: 'wallet',
    keywords: 'usługi koszty faktury budżet',
    run: { route: { view: 'services', id: null } },
  },
  {
    id: 'models',
    label: 'Modele AI i klucze API',
    icon: 'key',
    keywords: 'modele klucze api dostawcy anthropic openai gemini',
    run: { route: { view: 'models' } },
  },
  {
    id: 'settings',
    label: 'Ustawienia',
    icon: 'settings',
    keywords: 'ustawienia konto integracje budżet głos',
    run: { route: { view: 'settings' } },
  },
  {
    id: 'theme-light',
    label: 'Motyw jasny',
    icon: 'settings',
    keywords: 'motyw jasny wygląd',
    run: { action: 'theme-light' },
  },
  {
    id: 'theme-dark',
    label: 'Motyw ciemny',
    icon: 'settings',
    keywords: 'motyw ciemny wygląd noc',
    run: { action: 'theme-dark' },
  },
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ł/g, 'l') // „ł” nie rozkłada się w NFD
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

/**
 * Dopasowanie: każde słowo zapytania musi wystąpić w nazwie lub słowach kluczowych (bez polskich znaków).
 * Tekst, który nie pasuje do niczego (albo jest pytaniem), trafia jako „Zapytaj asystenta” na początek listy.
 */
export function matchCommands(query: string): Command[] {
  const q = norm(query.trim());
  if (!q) return COMMANDS;
  const words = q.split(/\s+/);
  const hits = COMMANDS.filter((c) => {
    const hay = norm(`${c.label} ${c.keywords}`);
    return words.every((w) => hay.includes(w));
  });
  const ask: Command = {
    id: 'ask',
    label: `Zapytaj asystenta: „${query.trim()}”`,
    hint: 'Enter',
    icon: 'send',
    keywords: '',
    run: { action: 'ask' },
  };
  const looksLikeQuestion = /\?$/.test(query.trim()) || words.length >= 3;
  return looksLikeQuestion || !hits.length ? [ask, ...hits] : [...hits, ask];
}
