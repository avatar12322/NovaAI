import { decide } from '@nova/permissions';
import { z } from 'zod';
import type { ToolContext, ToolDef } from '../tools/types';
import { mapErr } from './tool-errors';
import {
  ConnectorError,
  type BusyInterval,
  type ConnectorCapability,
  type Provider,
} from './types';

const MAX_RANGE_MS = 14 * 24 * 3600_000;
const MAX_EVENTS_RANGE_MS = 31 * 24 * 3600_000;

/** Nazwy usług w podglądach i wynikach. */
const MAIL_NAME: Record<Provider, string> = {
  google: 'Gmail',
  microsoft: 'Outlook',
  slack: 'Slack',
};
const CALENDAR_NAME: Record<Provider, string> = {
  google: 'Kalendarz Google',
  microsoft: 'Kalendarz Outlook',
  slack: 'Slack',
};

/** Konto wskazane przez model lub użytkownika; brak = jedyne połączone konto z daną funkcją. */
const Account = z.enum(['google', 'microsoft']).optional();

/** Ustalenie konta przy planowaniu — zamrożone w parametrach, więc zgoda dotyczy konkretnej skrzynki. */
async function resolveAccount(
  ctx: ToolContext,
  cap: ConnectorCapability,
  account: Provider | undefined,
): Promise<'google' | 'microsoft'> {
  try {
    return (await ctx.deps.connections.resolve(ctx.principal.userId, cap, account)) as
      'google' | 'microsoft';
  } catch (e) {
    mapErr(e);
  }
}

async function activeFreeBusyGrant(ctx: ToolContext, ownerUserId: string): Promise<boolean> {
  const r = await ctx.deps.db.owner.query(
    `SELECT 1 FROM calendar_grants
      WHERE owner_user_id = $1 AND household_id = $2 AND capability = 'calendar.freebusy' AND grantee = 'household_agent'
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [ownerUserId, ctx.householdId],
  );
  return r.rowCount === 1;
}

const UNAVAILABLE: Partial<Record<ConnectorError['code'], string>> = {
  reauth_required: 'kalendarz wymaga ponownego połączenia konta',
  scope_missing: 'brak uprawnienia do kalendarza',
  not_connected: 'kalendarz nie jest połączony',
};

/**
 * Zajętość jednej osoby: połączone kalendarze (Google freeBusy, Outlook calendarView — tylko przedziały),
 * a bez połączeń kalendarz lokalny. Bez tytułów wydarzeń. Trwały błąd konta jednej osoby nie blokuje
 * odpowiedzi dla pozostałych (błędy przejściowe — ponowienie zadania).
 */
async function busyOf(
  ctx: ToolContext,
  userId: string,
  from: string,
  to: string,
): Promise<{ busy: BusyInterval[]; source: string } | { unavailable: string }> {
  const conns = ctx.deps.connections;
  const providers = await conns.capable(userId, 'calendar.freebusy');
  if (providers.length) {
    const busy: BusyInterval[] = [];
    for (const p of providers) {
      try {
        busy.push(
          ...(await conns.call(userId, p, 'calendar.freebusy', (token, c) =>
            c.freeBusy!(token, from, to),
          )),
        );
      } catch (err) {
        if (err instanceof ConnectorError && !err.retryable)
          return { unavailable: UNAVAILABLE[err.code] ?? 'kalendarz chwilowo niedostępny' };
        throw err;
      }
    }
    busy.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return { busy, source: providers.join('+') };
  }
  const r = await ctx.deps.db.owner.query<{ starts_at: string; ends_at: string }>(
    `SELECT starts_at, ends_at FROM local_calendar_events
      WHERE owner_user_id = $1 AND household_id = $2 AND starts_at < $4 AND ends_at > $3 ORDER BY starts_at`,
    [userId, ctx.householdId, from, to],
  );
  return { busy: r.rows.map((x) => ({ start: x.starts_at, end: x.ends_at })), source: 'local' };
}

const FreeBusyParams = z
  .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
  .refine(
    (p) =>
      Date.parse(p.to) > Date.parse(p.from) &&
      Date.parse(p.to) - Date.parse(p.from) <= MAX_RANGE_MS,
    {
      message: 'zakres maks. 14 dni',
    },
  );

/**
 * calendar.freebusy — NovaAI dostaje WYŁĄCZNIE przedziały zajętości osób, które jawnie wydały grant.
 * Agent prywatny widzi zajętość tylko własnego kalendarza. Szczegóły wydarzeń nigdy nie są zwracane.
 */
const calendarFreeBusyTool: ToolDef<{ from: string; to: string }> = {
  name: 'calendar.freebusy',
  capability: 'calendar.freebusy',
  title: 'Sprawdź zajętość w kalendarzu',
  contexts: ['household_agent', 'private_agent'],
  params: FreeBusyParams as unknown as z.ZodType<{ from: string; to: string }>,
  readOnly: true,
  requiresApproval: () => false,
  async preview(_ctx, p) {
    return {
      summary: `Zajętość ${p.from} – ${p.to}`,
      target: 'kalendarz',
      scope: 'free/busy (bez szczegółów)',
    };
  },
  async authorize(ctx) {
    if (
      ctx.context === 'household_agent' ||
      ctx.context === 'private_agent' ||
      ctx.context === 'user'
    ) {
      return { allow: true, reason: 'checked_per_member_at_execution' };
    }
    return { allow: false, reason: 'context' };
  },
  async execute(ctx, p) {
    const actor = {
      userId: ctx.principal.userId,
      activeHouseholdIds: ctx.principal.activeHouseholdIds,
      context: ctx.context,
    };
    const members = await ctx.deps.db.owner.query<{ user_id: string; display_name: string }>(
      `SELECT m.user_id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.household_id = $1 AND m.status = 'active' ORDER BY m.created_at`,
      [ctx.householdId],
    );
    const targets =
      ctx.context === 'household_agent'
        ? members.rows
        : members.rows.filter((m) => m.user_id === ctx.principal.userId);
    const out: Array<{
      name: string;
      busy?: BusyInterval[];
      source?: string;
      unavailable?: string;
    }> = [];
    for (const m of targets) {
      const granted = await activeFreeBusyGrant(ctx, m.user_id);
      const d = decide(actor, 'calendar.freebusy', {
        type: 'calendar',
        ownerUserId: m.user_id,
        householdId: ctx.householdId,
        visibility: 'private',
        grants: granted ? [{ capability: 'calendar.freebusy' }] : [],
      });
      if (!d.allow) {
        out.push({ name: m.display_name, unavailable: 'brak zgody na udostępnienie zajętości' });
        continue;
      }
      out.push({ name: m.display_name, ...(await busyOf(ctx, m.user_id, p.from, p.to)) });
    }
    return {
      summary: `Zajętość ${p.from.slice(0, 16)} – ${p.to.slice(0, 16)}`,
      output: { members: out },
    };
  },
};

type EventsParams = { from: string; to: string; max: number; account?: 'google' | 'microsoft' };

/**
 * calendar.events — szczegóły wydarzeń (tytuł, czas, miejsce) z WŁASNEGO kalendarza, tylko dla agenta
 * prywatnego i tylko, gdy użytkownik włączył „odczyt wydarzeń” przy łączeniu konta. NovaAI tego nie ma.
 */
const calendarEventsTool: ToolDef<EventsParams> = {
  name: 'calendar.events',
  capability: 'calendar.read',
  title: 'Pokaż wydarzenia z kalendarza',
  contexts: ['private_agent'],
  resultVisibility: 'private',
  params: z
    .object({
      from: z.iso.datetime({ offset: true }),
      to: z.iso.datetime({ offset: true }),
      max: z.number().int().min(1).max(100).default(50),
      account: Account,
    })
    .refine(
      (p) =>
        Date.parse(p.to) > Date.parse(p.from) &&
        Date.parse(p.to) - Date.parse(p.from) <= MAX_EVENTS_RANGE_MS,
      { message: 'zakres maks. 31 dni' },
    ) as unknown as z.ZodType<EventsParams>,
  readOnly: true,
  requiresApproval: () => false,
  async prepare(ctx, p) {
    return { ...p, account: await resolveAccount(ctx, 'calendar.read', p.account) };
  },
  async preview(_c, p) {
    return {
      summary: `Wydarzenia ${p.from.slice(0, 16)} – ${p.to.slice(0, 16)}`,
      target: CALENDAR_NAME[p.account ?? 'microsoft'],
      scope: 'odczyt wydarzeń (prywatnie)',
    };
  },
  async authorize(ctx) {
    return ctx.context === 'private_agent'
      ? { allow: true, reason: 'owner' }
      : { allow: false, reason: 'calendar_details_private' };
  },
  async execute(ctx, p) {
    const provider = await resolveAccount(ctx, 'calendar.read', p.account);
    try {
      const events = await ctx.deps.connections.call(
        ctx.principal.userId,
        provider,
        'calendar.read',
        (token, c) => c.calendarEvents!(token, p.from, p.to, p.max),
      );
      // Tytuły i miejsca to NIEZAUFANE DANE — wynik narzędzia, nie instrukcja.
      return {
        summary: `${CALENDAR_NAME[provider]}: ${events.length} wydarzeń`,
        output: { account: provider, events },
      };
    } catch (e) {
      mapErr(e);
    }
  },
};

function mailTool<P extends Record<string, unknown>>(
  def: Omit<ToolDef<P>, 'contexts' | 'resultVisibility'> & { contexts?: ToolDef<P>['contexts'] },
): ToolDef<P> {
  return { contexts: ['private_agent'], resultVisibility: 'private', ...def };
}

const noMailForNova = async (ctx: ToolContext) =>
  ctx.context === 'household_agent'
    ? { allow: false, reason: 'household_agent_no_mail' }
    : { allow: true, reason: 'owner' };

type SearchParams = { query: string; max: number; account?: 'google' | 'microsoft' };

const mailSearchTool = mailTool<SearchParams>({
  name: 'mail.search',
  capability: 'mail.search',
  title: 'Szukaj w poczcie',
  params: z.object({
    query: z.string().trim().min(1).max(200),
    max: z.number().int().min(1).max(20).default(10),
    account: Account,
  }),
  readOnly: true,
  requiresApproval: () => false,
  async prepare(ctx, p) {
    return { ...p, account: await resolveAccount(ctx, 'mail.search', p.account) };
  },
  async preview(_c, p) {
    return {
      summary: `Wyszukiwanie: ${p.query}`,
      target: MAIL_NAME[p.account ?? 'google'],
      scope: 'odczyt',
    };
  },
  authorize: noMailForNova,
  async execute(ctx, p) {
    const provider = await resolveAccount(ctx, 'mail.search', p.account);
    try {
      const items = await ctx.deps.connections.call(
        ctx.principal.userId,
        provider,
        'mail.search',
        (token, c) => c.mailSearch!(token, p.query, p.max),
      );
      return {
        summary: `${MAIL_NAME[provider]}: znaleziono ${items.length} wiadomości`,
        output: { account: provider, messages: items },
      };
    } catch (e) {
      mapErr(e);
    }
  },
});

type ReadParams = { messageId: string; account?: 'google' | 'microsoft' };

const mailReadTool = mailTool<ReadParams>({
  name: 'mail.read',
  capability: 'mail.read',
  title: 'Odczytaj wiadomość',
  // Identyfikatory Gmail (hex) i Microsoft Graph (base64 z „-”, „_”, „=”); zawsze kodowane w ścieżce.
  params: z.object({
    messageId: z.string().regex(/^[A-Za-z0-9_\-+=/]{1,512}$/),
    account: Account,
  }),
  readOnly: true,
  requiresApproval: () => false,
  async prepare(ctx, p) {
    return { ...p, account: await resolveAccount(ctx, 'mail.read', p.account) };
  },
  async preview(_c, p) {
    return {
      summary: `Odczyt wiadomości ${p.messageId.slice(0, 40)}`,
      target: MAIL_NAME[p.account ?? 'google'],
      scope: 'odczyt',
    };
  },
  authorize: noMailForNova,
  async execute(ctx, p) {
    const provider = await resolveAccount(ctx, 'mail.read', p.account);
    try {
      const m = await ctx.deps.connections.call(
        ctx.principal.userId,
        provider,
        'mail.read',
        (token, c) => c.mailRead!(token, p.messageId),
      );
      // Treść maila to NIEZAUFANE DANE — trafia do rozmowy jako wynik narzędzia, nie jako instrukcja.
      return {
        summary: `Wiadomość: ${m.subject}`,
        output: {
          account: provider,
          from: m.from,
          to: m.to,
          subject: m.subject,
          date: m.date,
          content: m.body,
        },
      };
    } catch (e) {
      mapErr(e);
    }
  },
});

type OutgoingParams = {
  to: string;
  subject: string;
  body: string;
  account?: 'google' | 'microsoft';
};

const Outgoing = z.object({
  to: z.email().max(200),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((s) => !/[\r\n]/.test(s)),
  body: z.string().min(1).max(20_000),
  account: Account,
});

/**
 * Wiadomość wychodząca (wysyłka lub szkic): ZAWSZE zgoda z podglądem skrzynki nadawcy, odbiorcy i treści.
 * Konto jest ustalane przy planowaniu i należy do parametrów objętych skrótem zgody. Wynik niepewny =>
 * bez automatycznego ponowienia (nonIdempotentExternal).
 */
function outgoingTool(kind: 'send' | 'draft'): ToolDef<OutgoingParams> {
  const cap: ConnectorCapability = kind === 'send' ? 'mail.send' : 'mail.draft';
  return {
    name: cap,
    capability: cap,
    title: kind === 'send' ? 'Wyślij e-mail' : 'Przygotuj szkic e-maila',
    contexts: ['private_agent', 'user'],
    resultVisibility: 'private',
    nonIdempotentExternal: true,
    params: Outgoing,
    requiresApproval: () => true,
    async prepare(ctx, p) {
      return { ...p, account: await resolveAccount(ctx, cap, p.account) };
    },
    async preview(ctx, p) {
      const provider = p.account ?? 'google';
      const label = await ctx.deps.connections.accountLabel(ctx.principal.userId, provider);
      const from = `${MAIL_NAME[provider]}${label ? ` (${label})` : ''}`;
      return {
        summary:
          kind === 'send'
            ? `E-mail do ${p.to}: ${p.subject}`
            : `Szkic e-maila do ${p.to}: ${p.subject}`,
        target: p.to,
        scope:
          kind === 'send'
            ? `wysyłka e-mail z ${from}, jednorazowo`
            : `szkic w ${from} — bez wysyłki`,
        diff: `Temat: ${p.subject}\n\n${p.body}`,
      };
    },
    async authorize(ctx, p) {
      if (ctx.context === 'household_agent')
        return { allow: false, reason: 'household_agent_no_mail' };
      // Sprawdzane przy planowaniu i ponownie tuż przed wykonaniem (np. konto odłączone po zgodzie).
      const ok = await ctx.deps.connections.capable(ctx.principal.userId, cap);
      return p.account && ok.includes(p.account)
        ? { allow: true, reason: 'owner_connected' }
        : { allow: false, reason: 'connector:not_connected' };
    },
    async execute(ctx, p) {
      const provider = p.account!;
      const msg = { to: p.to, subject: p.subject, body: p.body };
      try {
        if (kind === 'send') {
          const r = await ctx.deps.connections.call(
            ctx.principal.userId,
            provider,
            cap,
            (token, c) => c.mailSend!(token, msg),
          );
          return {
            summary: `Wysłano e-mail do ${p.to} (${MAIL_NAME[provider]})`,
            output: { account: provider, messageId: r.id },
          };
        }
        const r = await ctx.deps.connections.call(ctx.principal.userId, provider, cap, (token, c) =>
          c.mailDraft!(token, msg),
        );
        return {
          summary: `Zapisano szkic do ${p.to} w ${MAIL_NAME[provider]} — nie wysłano`,
          output: { account: provider, draftId: r.id, webLink: r.webLink },
        };
      } catch (e) {
        mapErr(e);
      }
    },
  };
}

const mailSendTool = outgoingTool('send');
const mailDraftTool = outgoingTool('draft');

export const CONNECTOR_TOOLS: ToolDef[] = [
  calendarFreeBusyTool as unknown as ToolDef,
  calendarEventsTool as unknown as ToolDef,
  mailSearchTool as unknown as ToolDef,
  mailReadTool as unknown as ToolDef,
  mailSendTool as unknown as ToolDef,
  mailDraftTool as unknown as ToolDef,
];

/** Nazwy zdolności dla modelu, gdy są wyłączone (co powiedzieć użytkownikowi). */
export const CAPABILITY_PL: Partial<Record<ConnectorCapability, string>> = {
  'mail.search': 'wyszukiwanie poczty',
  'mail.read': 'odczyt treści e-maili',
  'mail.send': 'wysyłka e-maili',
  'mail.draft': 'szkice e-maili',
  'calendar.read': 'odczyt wydarzeń kalendarza',
  'chat.read': 'odczyt wiadomości ze Slacka',
  'chat.send': 'wysyłanie wiadomości na Slacku',
};

/** Narzędzia wymagające połączonego konta z daną zdolnością (bez konta model ich nie dostaje). */
export const CONNECTOR_REQUIRED: ReadonlyMap<string, ConnectorCapability> = new Map([
  ['calendar.events', 'calendar.read'],
  ['mail.search', 'mail.search'],
  ['mail.read', 'mail.read'],
  ['mail.send', 'mail.send'],
  ['mail.draft', 'mail.draft'],
  ['slack.mentions', 'chat.read'],
  ['slack.search', 'chat.read'],
  ['slack.send', 'chat.send'],
]);
