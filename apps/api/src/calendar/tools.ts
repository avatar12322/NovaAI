import { z } from 'zod';
import { plural } from '../briefing/routes';
import { withUserTx } from '../db/pool';
import type { ToolDef } from '../tools/types';
import { DEFAULT_ZONE, roomAndNotes } from './ics';

/**
 * calendar.agenda — wydarzenia z kalendarza NovaAI właściciela (dodane ręcznie i wgrane z pliku .ics, np. plan
 * zajęć): czas, tytuł, miejsce. Tylko agent prywatny; wynik prywatny. Nie wymaga połączonego konta.
 */
const MAX_RANGE_MS = 31 * 86_400_000;

type AgendaParams = { from: string; to: string; max: number };

const label = new Intl.DateTimeFormat('pl-PL', {
  timeZone: DEFAULT_ZONE,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export const calendarAgendaTool: ToolDef<AgendaParams> = {
  name: 'calendar.agenda',
  capability: 'calendar.local',
  title:
    'Pokaż wydarzenia z kalendarza NovaAI użytkownika (także wgrany plan zajęć): czas, tytuł, sala — np. „co mam jutro na uczelni?”',
  contexts: ['private_agent'],
  resultVisibility: 'private',
  readOnly: true,
  params: z
    .object({
      from: z.iso.datetime({ offset: true }),
      to: z.iso.datetime({ offset: true }),
      max: z.number().int().min(1).max(100).default(50),
    })
    .refine(
      (p) =>
        Date.parse(p.to) > Date.parse(p.from) &&
        Date.parse(p.to) - Date.parse(p.from) <= MAX_RANGE_MS,
      { message: 'zakres maks. 31 dni' },
    ) as unknown as z.ZodType<AgendaParams>,
  requiresApproval: () => false,
  async preview(_ctx, p) {
    return {
      summary: `Kalendarz ${p.from.slice(0, 10)} – ${p.to.slice(0, 10)}`,
      target: 'kalendarz NovaAI',
      scope: 'odczyt wydarzeń (prywatnie)',
    };
  },
  async authorize(ctx) {
    return ctx.context === 'private_agent'
      ? { allow: true, reason: 'owner' }
      : { allow: false, reason: 'calendar_details_private' };
  },
  async execute(ctx, p) {
    const r = await withUserTx(ctx.deps.db, { userId: ctx.principal.userId, scope: 'user' }, (c) =>
      c.query<{
        title: string;
        starts_at: Date;
        ends_at: Date;
        location: string | null;
        notes: string | null;
      }>(
        `SELECT title, starts_at, ends_at, location, notes FROM local_calendar_events
          WHERE owner_user_id = nova_uid() AND starts_at < $2 AND ends_at > $1
          ORDER BY starts_at LIMIT $3`,
        [p.from, p.to, p.max],
      ),
    );
    // Tytuły i sale to NIEZAUFANE DANE z pliku — wynik narzędzia, nie instrukcja.
    const events = r.rows.map((e) => {
      const { room, notes } = roomAndNotes(e.location, e.notes);
      return {
        start: label.format(new Date(e.starts_at)),
        end: label.format(new Date(e.ends_at)),
        allDay: false,
        subject: e.title,
        location: room ?? '',
        // Zwięzłe szczegóły z opisu (np. prowadzący, grupa) — bez długich opisów w kontekście modelu.
        details: notes ? notes.slice(0, 200) : '',
      };
    });
    return {
      summary: `Kalendarz NovaAI: ${plural(events.length, 'wydarzenie', 'wydarzenia', 'wydarzeń')}`,
      output: { account: 'local', events },
    };
  },
};
