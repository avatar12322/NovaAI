const rtf = new Intl.RelativeTimeFormat('pl', { numeric: 'auto' });

export function timeAgo(iso: string, now = Date.now()): string {
  const diff = (Date.parse(iso) - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'przed chwilą';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}

export const TASK_STATUS_PL: Record<string, string> = {
  queued: 'w kolejce',
  running: 'w toku',
  waiting_approval: 'czeka na zgodę',
  completed: 'zakończone',
  failed: 'błąd',
  cancelled: 'anulowane',
};

export const STEP_STATUS_PL: Record<string, string> = {
  pending: 'oczekuje',
  running: 'w toku',
  waiting_approval: 'czeka na zgodę',
  completed: 'gotowe',
  failed: 'błąd',
  cancelled: 'anulowane',
  skipped: 'pominięte',
};

export const EVENT_PL: Record<string, string> = {
  'task.created': 'Nowe zadanie',
  'task.status': 'Status zadania',
  'task.progress': 'Postęp',
  'step.status': 'Krok',
  'approval.requested': 'Prośba o zgodę',
  'approval.resolved': 'Zgoda rozstrzygnięta',
  'message.created': 'Wiadomość',
  'memory.changed': 'Pamięć',
  'notification.created': 'Powiadomienie',
  'budget.warning': 'Budżet: ostrzeżenie',
  'budget.blocked': 'Budżet: blokada',
  'budget.changed': 'Budżet: zmiana ustawień',
  'device.status': 'Urządzenie',
  'document.updated': 'Dokument',
};

/** Statusy i zmiany widoczności dokumentu (zdarzenie `document.updated`). */
export const DOCUMENT_STATUS_PL: Record<string, string> = {
  pending: 'w kolejce',
  indexing: 'indeksowanie',
  ready: 'gotowy',
  failed: 'błąd odczytu',
  deleted: 'usunięty',
  shared: 'udostępniony',
  removed: 'udostępnienie cofnięte',
};

export function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** Miejsce w dokumencie: „s. 3”, „Umowa › Kaucja, linie 5–7”. */
export function locatorLabel(l: {
  page: number | null;
  lineStart: number | null;
  lineEnd: number | null;
  heading: string | null;
}): string {
  if (l.page !== null) return `s. ${l.page}`;
  const lines =
    l.lineStart === null
      ? ''
      : l.lineEnd !== null && l.lineEnd !== l.lineStart
        ? `linie ${l.lineStart}–${l.lineEnd}`
        : `linia ${l.lineStart}`;
  return [l.heading, lines].filter(Boolean).join(', ') || 'fragment';
}

/** Czytelne powody odrzucenia akcji: brak połączonego konta odróżniony od braku uprawnień kontekstu. */
export const CONNECTOR_DENY_PL: Record<string, string> = {
  'connector:not_connected':
    'Potrzebne konto (poczta, kalendarz lub Slack) nie jest połączone — połącz je w Ustawieniach → Integracje.',
  'connector:reauth_required':
    'Dostęp do konta wygasł lub został cofnięty — połącz je ponownie w Ustawieniach → Integracje.',
  'connector:scope_missing':
    'Połączone konto nie obejmuje tej funkcji — połącz je ponownie i zaznacz potrzebny dostęp.',
  'connector:ambiguous_account':
    'Połączono kilka kont z tą funkcją — napisz, którego użyć (Outlook lub Gmail).',
  'connector:not_configured': 'Ta integracja nie jest skonfigurowana na serwerze.',
  'connector:not_in_channel': 'Nie należysz do tego kanału Slack — wiadomość nie zostanie wysłana.',
  'connector:is_archived': 'Ten kanał Slack jest zarchiwizowany.',
  'connector:channel_not_found': 'Nie znaleziono kanału Slack (albo nie masz do niego dostępu).',
  'connector:unsupported_conversation':
    'Wysyłka do rozmów bezpośrednich i grupowych na Slacku nie jest obsługiwana — wybierz kanał.',
  'connector:restricted_action': 'Zasady workspace’u Slack nie pozwalają na tę akcję.',
  'connector:msg_too_long': 'Wiadomość jest za długa dla Slacka.',
  'connector:search_disabled':
    'Wyszukiwanie dla aplikacji jest wyłączone w tym workspace Slack (decyzja administratora).',
};

/** Błąd kroku zadania do wyświetlenia: odmowy integracji jako zrozumiały komunikat. */
export function stepErrorPl(error: string): string {
  const m = /^Odmowa: (connector:[a-z_]+)$/.exec(error);
  return (m && CONNECTOR_DENY_PL[m[1]!]) || error;
}

/** Polska odmiana liczebników: 1 wydarzenie, 2–4 wydarzenia, 5+ wydarzeń (12–14 też „wydarzeń”). */
export function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const t = n % 100;
  const form = n === 1 ? one : d >= 2 && d <= 4 && (t < 12 || t > 14) ? few : many;
  return `${n} ${form}`;
}
