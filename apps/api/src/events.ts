import type { EventType, NovaEvent } from '@nova/contracts';
import pg from 'pg';
import type { Db, Queryable } from './db/pool';
import { redact } from './lib/redact';

interface EmitEvent {
  householdId: string;
  ownerUserId: string | null;
  visibility: 'private' | 'shared';
  taskId?: string | null;
  type: EventType;
  /** Tylko identyfikatory, statusy, tytuły. Klucze z sekretami/treścią są redagowane. */
  payload?: Record<string, unknown>;
}

/** Zapis zdarzenia w bieżącej transakcji (NOTIFY wyśle się dopiero po COMMIT). */
export async function emitEvent(c: Queryable, e: EmitEvent): Promise<void> {
  await c.query(
    `INSERT INTO events (household_id, owner_user_id, visibility, task_id, type, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      e.householdId,
      e.ownerUserId,
      e.visibility,
      e.taskId ?? null,
      e.type,
      JSON.stringify(redact(e.payload ?? {})),
    ],
  );
}

interface EventRow {
  id: number;
  type: EventType;
  visibility: 'private' | 'shared';
  task_id: string | null;
  owner_user_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export const EVENT_SELECT = `SELECT id, type, visibility, task_id, owner_user_id, payload, created_at FROM events`;

export const toEvent = (r: EventRow): NovaEvent => ({
  id: r.id,
  type: r.type,
  visibility: r.visibility,
  taskId: r.task_id,
  ownerUserId: r.owner_user_id,
  payload: r.payload,
  createdAt: r.created_at,
});

type Listener = (eventId: number) => void;

/**
 * Nasłuch `LISTEN nova_events` na jednym dedykowanym połączeniu. Odbiorcy dostają tylko ID
 * i sami pobierają zdarzenie w swoim kontekście RLS.
 */
export class EventHub {
  private client: pg.Client | null = null;
  private listeners = new Set<Listener>();
  private starting: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly db: Db) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    void this.ensureStarted();
    return () => this.listeners.delete(fn);
  }

  get size(): number {
    return this.listeners.size;
  }

  private async ensureStarted(): Promise<void> {
    if (this.client || this.stopped) return;
    if (!this.starting) {
      this.starting = (async () => {
        const opts = this.db.owner.options;
        const client = new pg.Client({
          connectionString: opts.connectionString,
          application_name: 'nova-events',
        });
        await client.connect();
        client.on('notification', (msg) => {
          const id = Number(msg.payload);
          if (!Number.isFinite(id)) return;
          for (const l of this.listeners) l(id);
        });
        client.on('error', () => {
          this.client = null;
          this.starting = null;
          if (!this.stopped && this.listeners.size > 0)
            setTimeout(() => void this.ensureStarted(), 1000);
        });
        await client.query('LISTEN nova_events');
        this.client = client;
      })().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  async ready(): Promise<void> {
    await this.ensureStarted();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.listeners.clear();
    if (this.starting) await this.starting.catch(() => undefined);
    if (this.client) {
      await this.client.end().catch(() => undefined);
      this.client = null;
    }
  }
}
