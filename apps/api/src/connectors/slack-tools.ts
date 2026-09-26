import { z } from 'zod';
import { ToolDenied, type ToolContext, type ToolDef } from '../tools/types';
import type { ConnectionService } from './service';
import { channelTypesFor } from './slack';
import { mapErr } from './tool-errors';
import { ConnectorError, type ChatMessage } from './types';

/**
 * Narzędzia Slacka. Odczyt: wyłącznie agent prywatny, tokenem tej osoby; wynik narzędzia zawiera tylko liczbę
 * i parametry (`live`), a treść jest pobierana na żywo (zasady Slacka zabraniają przechowywania wyników
 * wyszukiwania). Wysyłka: zawsze zgoda z podglądem nazwy kanału pobranej ze Slacka, nie od modelu.
 */
interface SlackLiveQuery {
  kind: 'mentions' | 'search';
  query?: string;
  days: number;
  max: number;
}

/** Wiadomości ze Slacka na żywo, tokenem wskazanej osoby (Slack sam ogranicza wyniki do jej dostępu). */
export async function slackLive(
  conns: ConnectionService,
  userId: string,
  q: SlackLiveQuery,
): Promise<ChatMessage[]> {
  await conns.resolve(userId, 'chat.read', 'slack');
  const meta = await conns.meta(userId, 'slack');
  if (!meta?.externalUserId) throw new ConnectorError('not_connected', 'Brak połączenia Slack');
  const query = q.kind === 'mentions' ? `<@${meta.externalUserId}>` : (q.query ?? '');
  const after = Math.floor(Date.now() / 1000) - q.days * 86_400;
  return conns.call(userId, 'slack', 'chat.read', (token, c) =>
    c.chatSearch!(token, {
      query,
      channelTypes: channelTypesFor(meta.capabilities),
      limit: q.max,
      after,
    }),
  );
}

const tsToIso = (ts: string) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : ts;
};

/** Forma dla modelu: NIEZAUFANE DANE (treść cudzych wiadomości), skrócone. */
function formatChatForModel(items: ChatMessage[]): string {
  if (!items.length) return 'Brak wyników.';
  return items
    .map(
      (m) =>
        `[${m.channelName ? `#${m.channelName}` : m.channelId}] ${m.author || m.authorId} (${tsToIso(m.ts)}): ` +
        m.text.replace(/\s+/g, ' ').slice(0, 500),
    )
    .join('\n');
}

const noChatForNova = async (ctx: ToolContext) =>
  ctx.context === 'household_agent'
    ? { allow: false, reason: 'household_agent_no_chat' }
    : { allow: true, reason: 'owner' };

async function requireSlack(ctx: ToolContext, cap: 'chat.read' | 'chat.send'): Promise<void> {
  try {
    await ctx.deps.connections.resolve(ctx.principal.userId, cap, 'slack');
  } catch (e) {
    mapErr(e);
  }
}

type ReadParams = { days: number; max: number; query?: string };

function readTool(kind: 'mentions' | 'search'): ToolDef<ReadParams> {
  const base = {
    days: z.number().int().min(1).max(30).default(7),
    max: z.number().int().min(1).max(20).default(10),
  };
  return {
    name: kind === 'mentions' ? 'slack.mentions' : 'slack.search',
    capability: 'chat.read',
    title: kind === 'mentions' ? 'Moje wzmianki na Slacku' : 'Szukaj na Slacku',
    contexts: ['private_agent'],
    resultVisibility: 'private',
    readOnly: true,
    params: (kind === 'mentions'
      ? z.object(base)
      : z.object({ ...base, query: z.string().trim().min(1).max(200) })) as z.ZodType<ReadParams>,
    requiresApproval: () => false,
    async prepare(ctx, p) {
      await requireSlack(ctx, 'chat.read');
      return p;
    },
    async preview(_c, p) {
      return {
        summary:
          kind === 'mentions'
            ? `Wzmianki na Slacku (${p.days} dni)`
            : `Slack: ${p.query ?? ''} (${p.days} dni)`,
        target: 'Slack',
        scope: 'odczyt na żywo, bez zapisu treści',
      };
    },
    authorize: noChatForNova,
    async execute(ctx, p) {
      let items: ChatMessage[];
      try {
        items = await slackLive(ctx.deps.connections, ctx.principal.userId, { kind, ...p });
      } catch (e) {
        mapErr(e);
      }
      const what = kind === 'mentions' ? 'wzmianki' : `wiadomości „${p.query ?? ''}”`;
      return {
        summary: `Slack — ${what} z ostatnich ${p.days} dni: ${items.length}. Treść nie jest zapisywana w NovaAI (zasady Slacka); pokaż ją na żywo.`,
        output: {
          account: 'slack',
          count: items.length,
          live: { kind, days: p.days, max: p.max, ...(p.query ? { query: p.query } : {}) },
        },
      };
    },
    async live(ctx, params) {
      const q = params as unknown as SlackLiveQuery;
      return formatChatForModel(await slackLive(ctx.deps.connections, ctx.principal.userId, q));
    },
  };
}

type SendParams = { channel: string; text: string; threadTs?: string; channelLabel?: string };

/** Wysyłka jako ta osoba: ZAWSZE zgoda; kanał i jego nazwa ustalane ze Slacka przy planowaniu. */
const slackSendTool: ToolDef<SendParams> = {
  name: 'slack.send',
  capability: 'chat.send',
  title: 'Wyślij wiadomość na Slacku',
  contexts: ['private_agent', 'user'],
  resultVisibility: 'private',
  nonIdempotentExternal: true,
  params: z.object({
    // Kanały publiczne i prywatne (C…/G…); rozmowy bezpośrednie (D…) nie są obsługiwane.
    channel: z.string().regex(/^[CG][A-Z0-9]{6,20}$/),
    text: z.string().trim().min(1).max(4000),
    threadTs: z
      .string()
      .regex(/^\d{9,11}\.\d{1,8}$/)
      .optional(),
    channelLabel: z.string().max(120).optional(),
  }),
  requiresApproval: () => true,
  async prepare(ctx, p) {
    await requireSlack(ctx, 'chat.send');
    let ch;
    try {
      ch = await ctx.deps.connections.call(ctx.principal.userId, 'slack', 'chat.send', (t, c) =>
        c.chatChannel!(t, p.channel),
      );
    } catch (e) {
      // Rozmowy grupowe/bezpośrednie wymagają innych zakresów — nie wysyłamy tam.
      if (e instanceof ConnectorError && e.code === 'scope_missing')
        throw new ToolDenied('connector:unsupported_conversation');
      mapErr(e);
    }
    if (ch.kind === 'im' || ch.kind === 'mpim')
      throw new ToolDenied('connector:unsupported_conversation');
    if (ch.isArchived) throw new ToolDenied('connector:is_archived');
    if (!ch.isMember) throw new ToolDenied('connector:not_in_channel');
    // Nazwa ze Slacka nadpisuje cokolwiek podał model — podgląd zgody pokazuje prawdziwy cel.
    return {
      ...p,
      channel: ch.id,
      channelLabel: `#${ch.name}${ch.kind === 'private' ? ' (kanał prywatny)' : ''}`,
    };
  },
  async preview(ctx, p) {
    const account = await ctx.deps.connections.accountLabel(ctx.principal.userId, 'slack');
    const label = p.channelLabel ?? p.channel;
    return {
      summary: `Wiadomość na Slacku do ${label}${p.threadTs ? ' (odpowiedź w wątku)' : ''}`,
      target: label,
      scope: `wysłanie jako ${account ?? 'Ty'}, jednorazowo`,
      diff: p.text,
    };
  },
  async authorize(ctx) {
    if (ctx.context === 'household_agent')
      return { allow: false, reason: 'household_agent_no_chat' };
    // Sprawdzane przy planowaniu i ponownie tuż przed wysłaniem (np. konto odłączone po zgodzie).
    const ok = await ctx.deps.connections.capable(ctx.principal.userId, 'chat.send');
    return ok.includes('slack')
      ? { allow: true, reason: 'owner_connected' }
      : { allow: false, reason: 'connector:not_connected' };
  },
  async execute(ctx, p) {
    try {
      const r = await ctx.deps.connections.call(
        ctx.principal.userId,
        'slack',
        'chat.send',
        (t, c) => c.chatSend!(t, { channel: p.channel, text: p.text, threadTs: p.threadTs }),
      );
      return {
        summary: `Wysłano wiadomość na Slacku do ${p.channelLabel ?? p.channel}`,
        output: { account: 'slack', channel: r.channel, ts: r.ts },
      };
    } catch (e) {
      mapErr(e);
    }
  },
};

const slackMentionsTool = readTool('mentions');
const slackSearchTool = readTool('search');

export const SLACK_TOOLS: ToolDef[] = [
  slackMentionsTool as unknown as ToolDef,
  slackSearchTool as unknown as ToolDef,
  slackSendTool as unknown as ToolDef,
];
