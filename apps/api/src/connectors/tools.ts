import { decide } from '@nova/permissions';
import { z } from 'zod';
import { ToolDenied, type ToolContext, type ToolDef } from '../tools/types';
import { ConnectorError, type BusyInterval } from './types';

const FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
const MAX_RANGE_MS = 14 * 24 * 3600_000;

function mapErr(err: unknown): never {
  if (err instanceof ConnectorError) {
    if (err.retryable) throw err;
    throw new ToolDenied(`connector:${err.code}`);
  }
  throw err;
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

/** Zajętość jednej osoby: Google (zakres calendar.freebusy) albo kalendarz lokalny. Bez tytułów wydarzeń. */
async function busyOf(
  ctx: ToolContext,
  userId: string,
  from: string,
  to: string,
): Promise<{ busy: BusyInterval[]; source: string }> {
  const conns = ctx.deps.connections;
  if (await conns.hasScope(userId, 'google', FREEBUSY_SCOPE)) {
    try {
      const token = await conns.accessToken(userId, 'google', FREEBUSY_SCOPE);
      return { busy: await conns.connector('google').freeBusy!(token, from, to), source: 'google' };
    } catch (err) {
      mapErr(err);
    }
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
export const calendarFreeBusyTool: ToolDef<{ from: string; to: string }> = {
  name: 'calendar.freebusy',
  capability: 'calendar.freebusy',
  title: 'Sprawdź zajętość w kalendarzu',
  contexts: ['household_agent', 'private_agent'],
  params: FreeBusyParams as unknown as z.ZodType<{ from: string; to: string }>,
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
      const b = await busyOf(ctx, m.user_id, p.from, p.to);
      out.push({ name: m.display_name, busy: b.busy, source: b.source });
    }
    return {
      summary: `Zajętość ${p.from.slice(0, 16)} – ${p.to.slice(0, 16)}`,
      output: { members: out },
    };
  },
};

function mailTool<P extends Record<string, unknown>>(
  def: Omit<ToolDef<P>, 'contexts' | 'resultVisibility'> & { contexts?: ToolDef<P>['contexts'] },
): ToolDef<P> {
  return { contexts: ['private_agent'], resultVisibility: 'private', ...def };
}

const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export const mailSearchTool = mailTool<{ query: string; max: number }>({
  name: 'mail.search',
  capability: 'mail.search',
  title: 'Szukaj w poczcie (Gmail)',
  params: z.object({
    query: z.string().trim().min(1).max(200),
    max: z.number().int().min(1).max(20).default(10),
  }),
  requiresApproval: () => false,
  async preview(_c, p) {
    return { summary: `Wyszukiwanie: ${p.query}`, target: 'Gmail', scope: 'odczyt' };
  },
  async authorize(ctx) {
    return ctx.context === 'household_agent'
      ? { allow: false, reason: 'household_agent_no_mail' }
      : { allow: true, reason: 'owner' };
  },
  async execute(ctx, p) {
    try {
      const token = await ctx.deps.connections.accessToken(
        ctx.principal.userId,
        'google',
        READ_SCOPE,
      );
      const items = await ctx.deps.connections.connector('google').mailSearch!(
        token,
        p.query,
        p.max,
      );
      return { summary: `Znaleziono ${items.length} wiadomości`, output: { messages: items } };
    } catch (e) {
      mapErr(e);
    }
  },
});

export const mailReadTool = mailTool<{ messageId: string }>({
  name: 'mail.read',
  capability: 'mail.read',
  title: 'Odczytaj wiadomość (Gmail)',
  params: z.object({ messageId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
  requiresApproval: () => false,
  async preview(_c, p) {
    return { summary: `Odczyt wiadomości ${p.messageId}`, target: 'Gmail', scope: 'odczyt' };
  },
  async authorize(ctx) {
    return ctx.context === 'household_agent'
      ? { allow: false, reason: 'household_agent_no_mail' }
      : { allow: true, reason: 'owner' };
  },
  async execute(ctx, p) {
    try {
      const token = await ctx.deps.connections.accessToken(
        ctx.principal.userId,
        'google',
        READ_SCOPE,
      );
      const m = await ctx.deps.connections.connector('google').mailRead!(token, p.messageId);
      // Treść maila to NIEZAUFANE DANE — trafia do rozmowy jako wynik narzędzia, nie jako instrukcja.
      return {
        summary: `Wiadomość: ${m.subject}`,
        output: { from: m.from, to: m.to, subject: m.subject, date: m.date, content: m.body },
      };
    } catch (e) {
      mapErr(e);
    }
  },
});

/** Wysyłka maila: ZAWSZE zgoda z podglądem odbiorcy i treści; wynik niepewny => bez automatycznego ponowienia. */
export const mailSendTool: ToolDef<{ to: string; subject: string; body: string }> = {
  name: 'mail.send',
  capability: 'mail.send',
  title: 'Wyślij e-mail (Gmail)',
  contexts: ['private_agent', 'user'],
  resultVisibility: 'private',
  nonIdempotentExternal: true,
  params: z.object({
    to: z.email().max(200),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((s) => !/[\r\n]/.test(s)),
    body: z.string().min(1).max(20_000),
  }),
  requiresApproval: () => true,
  async preview(_c, p) {
    return {
      summary: `E-mail do ${p.to}: ${p.subject}`,
      target: p.to,
      scope: 'wysyłka e-mail (Gmail, jednorazowo)',
      diff: `Temat: ${p.subject}\n\n${p.body}`,
    };
  },
  async authorize(ctx) {
    if (ctx.context === 'household_agent')
      return { allow: false, reason: 'household_agent_no_mail' };
    return (await ctx.deps.connections.hasScope(ctx.principal.userId, 'google', SEND_SCOPE))
      ? { allow: true, reason: 'owner_connected' }
      : { allow: false, reason: 'connector:not_connected' };
  },
  async execute(ctx, p) {
    try {
      const token = await ctx.deps.connections.accessToken(
        ctx.principal.userId,
        'google',
        SEND_SCOPE,
      );
      const r = await ctx.deps.connections.connector('google').mailSend!(token, p);
      return { summary: `Wysłano e-mail do ${p.to}`, output: { messageId: r.id } };
    } catch (e) {
      mapErr(e);
    }
  },
};

export const CONNECTOR_TOOLS: ToolDef[] = [
  calendarFreeBusyTool as unknown as ToolDef,
  mailSearchTool as unknown as ToolDef,
  mailReadTool as unknown as ToolDef,
  mailSendTool as unknown as ToolDef,
];

export function assertNever(x: never): never {
  throw new ToolDenied(String(x));
}
