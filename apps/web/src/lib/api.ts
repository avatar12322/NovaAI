import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type {
  Device,
  DocumentChunk,
  DocumentInfo,
  DocumentPage,
  DocumentSearchHit,
  GrantCapability,
  Approval,
  ApprovalPage,
  Conversation,
  ConversationPage,
  CreateTaskRequest,
  DevUser,
  HealthResponse,
  MeResponse,
  Memory,
  MemoryKind,
  MemoryPage,
  MessagePage,
  Notification,
  NovaEvent,
  PostMessageResponse,
  Space,
  Task,
  TaskPage,
} from '@nova/contracts';
import type { CostAdapterInfo, CostEntryInfo, CostSummary, ServiceInfo } from '@nova/contracts';
import type { Briefing, ModelsOverview, ProviderCheckResult } from '@nova/contracts';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Szczegóły błędu z serwera (np. lista błędnych wierszy importu). */
    public readonly details?: unknown,
  ) {
    super(message);
  }
  get offline(): boolean {
    return this.status === 0;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-nova-csrf': '1' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'offline', 'Brak połączenia z serwerem');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, 'bad_response', 'Nieoczekiwana odpowiedź serwera');
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)
      ?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'error',
      err?.message ?? `Błąd ${res.status}`,
      err?.details,
    );
  }
  return data as T;
}

/** Wysyłka pliku jako surowych bajtów (bez multipart); typ ustala serwer z rozszerzenia i treści. */
async function uploadFile<T>(
  path: string,
  file: Blob,
  contentType = 'application/octet-stream',
  method: 'POST' | 'PUT' = 'POST',
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': contentType, 'x-nova-csrf': '1' },
      body: file,
    });
  } catch {
    throw new ApiError(0, 'offline', 'Brak połączenia z serwerem');
  }
  const data = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'error',
      data?.error?.message ?? `Błąd ${res.status}`,
    );
  }
  return data as T;
}

/** Komunikat błędu z API; przy walidacji — konkretne powody z serwera (bez wartości pól). */
export function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Błąd';
  const reasons = Array.isArray(e.details)
    ? [
        ...new Set(
          (e.details as Array<{ message?: unknown }>)
            .map((d) => (typeof d.message === 'string' ? d.message : null))
            .filter((m): m is string => !!m),
        ),
      ]
    : [];
  return reasons.length ? reasons.join(' ') : e.message;
}

const get = <T>(p: string) => request<T>('GET', p);
const post = <T>(p: string, b: unknown = {}) => request<T>('POST', p, b);
const qs = (o: Record<string, string | number | undefined>) => {
  const e = Object.entries(o).filter(([, v]) => v !== undefined && v !== '') as Array<
    [string, string | number]
  >;
  return e.length ? `?${e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
};

export interface BudgetStatus {
  currency: string;
  period: string;
  spent: number;
  estimatedShare: number;
  softLimit: number | null;
  hardLimit: number | null;
  state: 'ok' | 'warning' | 'blocked';
  paidCallsEnabled: boolean;
  byProvider: Array<{
    provider: string;
    model: string;
    cost: number;
    calls: number;
    estimated: boolean;
  }>;
}

export interface ConnectionInfo {
  provider: 'google' | 'microsoft' | 'slack';
  title: string;
  capabilities: string[];
  configured: boolean;
  reason: string | null;
  /** Uprawnienia dostawcy, o które aplikacja poprosi dla danej zdolności. */
  permissions: Record<string, string[]>;
  notes: Array<{ title: string; text: string }>;
  revocationHelp: string | null;
  connection: {
    status: string;
    scopes: string[];
    capabilities: string[];
    account: string | null;
    updatedAt: string;
    lastError: string | null;
  } | null;
}

export interface SlackLiveItem {
  author: string;
  authorId: string;
  channelId: string;
  channelName: string;
  ts: string;
  text: string;
  permalink: string;
}

/** Osoba w domu; `email` widzi właściciel i sama osoba. */
export interface HouseholdMember {
  id: string;
  displayName: string;
  email: string | null;
  role: 'owner' | 'member';
  status: 'active' | 'invited';
  inviteExpiresAt: string | null;
  me: boolean;
}

/** Kalendarz wgrany z pliku .ics (np. plan zajęć). */
export interface CalendarImport {
  id: string;
  name: string;
  eventCount: number;
  /** Zajęcia z pokazywanych (nieodznaczonych) przedmiotów. */
  visibleCount: number;
  updatedAt: string;
  firstAt: string | null;
  lastAt: string | null;
  nextAt: string | null;
  subjects: Array<{ title: string; count: number; hidden: boolean }>;
}

export interface LocalEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
}

export interface Reminder {
  id: string;
  visibility: 'private' | 'shared';
  text: string;
  dueAt: string;
  status: 'scheduled' | 'fired' | 'cancelled';
  isMine: boolean;
  ownerName: string;
  firedAt: string | null;
}

export interface ModelStatus {
  mode: 'configured' | 'demo';
  providers: Array<{ name: string; kind: string; configured: boolean; reason: string | null }>;
}

/** Głos z serwera: synteza (odczyt) i rozpoznawanie mowy ElevenLabs; null — niedostępne. */
export interface VoiceStatus {
  provider: 'elevenlabs' | null;
  voiceId: string | null;
  modelId: string | null;
  monthChars: number;
  monthlyLimit: number | null;
  stt: {
    provider: 'elevenlabs';
    modelId: string;
    monthMinutes: number;
    monthlyLimitMinutes: number;
  } | null;
}

export const api = {
  health: () => get<HealthResponse>('/health'),
  me: () => get<MeResponse>('/me'),
  devUsers: () => get<{ users: DevUser[]; notice: string }>('/auth/dev-users'),
  devLogin: (user: string) => post<{ ok: true }>('/auth/dev-login', { user }),
  logout: () => post<{ ok: true }>('/auth/logout'),
  authConfig: () => get<{ devLogin: boolean; passkeys: boolean; rpId: string }>('/auth/config'),
  passkeyLoginOptions: () =>
    post<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
      '/auth/passkeys/login/options',
    ),
  passkeyLoginVerify: (challengeId: string, response: unknown) =>
    post<{ ok: true }>('/auth/passkeys/login/verify', { challengeId, response }),
  passkeyRegisterOptions: () =>
    post<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
      '/auth/passkeys/register/options',
    ),
  passkeyRegisterVerify: (challengeId: string, response: unknown, name?: string) =>
    post<{ ok: true }>('/auth/passkeys/register/verify', { challengeId, response, name }),
  passkeys: () =>
    get<{
      items: Array<{
        id: string;
        name: string;
        createdAt: string;
        lastUsedAt: string | null;
        backedUp: boolean;
      }>;
    }>('/auth/passkeys'),
  deletePasskey: (id: string) => request<void>('DELETE', `/auth/passkeys/${id}`),
  enrollOptions: (token: string) =>
    post<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
      '/auth/enroll/options',
      { token },
    ),
  enrollVerify: (token: string, challengeId: string, response: unknown) =>
    post<{ ok: true }>('/auth/enroll/verify', { token, challengeId, response }),

  conversations: (space: Space, cursor?: string) =>
    get<ConversationPage>(`/conversations${qs({ space, cursor })}`),
  createConversation: (space: Space, title?: string) =>
    post<Conversation>('/conversations', { space, title }),
  conversation: (id: string) => get<Conversation>(`/conversations/${id}`),
  messages: (id: string, cursor?: string) =>
    get<MessagePage>(`/conversations/${id}/messages${qs({ limit: 50, cursor })}`),
  sendMessage: (id: string, content: string) =>
    post<PostMessageResponse>(`/conversations/${id}/messages`, { content }),

  memories: (space: Space) => get<MemoryPage>(`/memories${qs({ space, limit: 100 })}`),
  createMemory: (content: string, kind: MemoryKind, space: Space) =>
    post<Memory>('/memories', { content, kind, space }),
  updateMemory: (id: string, content: string) =>
    request<Memory>('PATCH', `/memories/${id}`, { content }),
  shareMemory: (id: string) => post<Memory>(`/memories/${id}/share`),
  unshareMemory: (id: string) => post<Memory>(`/memories/${id}/unshare`),
  deleteMemory: (id: string) => request<void>('DELETE', `/memories/${id}`),

  documents: (space: Space, cursor?: string) =>
    get<DocumentPage>(`/documents${qs({ space, limit: 50, cursor })}`),
  document: (id: string) => get<DocumentInfo>(`/documents/${id}`),
  documentChunk: (id: string, ord: number) => get<DocumentChunk>(`/documents/${id}/chunks/${ord}`),
  searchDocuments: (q: string) =>
    get<{ items: DocumentSearchHit[] }>(`/documents/search${qs({ q, limit: 12 })}`),
  uploadDocument: (file: File, space: Space) =>
    uploadFile<{ document: DocumentInfo; taskId: string }>(
      `/documents${qs({ name: file.name, space })}`,
      file,
    ),
  shareDocument: (id: string) => post<DocumentInfo>(`/documents/${id}/share`),
  unshareDocument: (id: string) => post<DocumentInfo>(`/documents/${id}/unshare`),
  reindexDocument: (id: string) => post<{ document: DocumentInfo }>(`/documents/${id}/reindex`),
  deleteDocument: (id: string) => request<{ ok: true }>('DELETE', `/documents/${id}`),
  documentFileUrl: (id: string) => `/api/documents/${id}/file`,

  tasks: (space: Space, status: 'active' | 'all' = 'all') =>
    get<TaskPage>(`/tasks${qs({ space, status, limit: 50 })}`),
  task: (id: string) => get<Task>(`/tasks/${id}`),
  createTask: (body: CreateTaskRequest) => post<Task>('/tasks', body),
  cancelTask: (id: string) => post<Task>(`/tasks/${id}/cancel`),

  approvals: (status: 'pending' | 'all' = 'pending') =>
    get<ApprovalPage>(`/approvals${qs({ status })}`),
  approve: (id: string, actionHash: string) =>
    post<Approval>(`/approvals/${id}/approve`, { actionHash }),
  reject: (id: string, reason?: string) => post<Approval>(`/approvals/${id}/reject`, { reason }),

  events: (after: number) =>
    get<{ items: NovaEvent[]; lastId: number }>(`/events${qs({ after, limit: 100 })}`),
  notifications: () => get<{ items: Notification[]; unread: number }>('/notifications'),
  readNotification: (id: string) => post<{ ok: boolean }>(`/notifications/${id}/read`),

  budget: () => get<BudgetStatus>('/budget'),
  setBudget: (b: {
    softLimit: number | null;
    hardLimit: number | null;
    paidCallsEnabled: boolean;
  }) => request<BudgetStatus>('PUT', '/budget', b),
  modelStatus: () => get<ModelStatus>('/model/status'),
  briefing: () => get<Briefing>('/briefing'),
  ttsStatus: () => get<VoiceStatus>('/tts/status'),
  /** Rozpoznawanie mowy przez serwer (ElevenLabs) — zapas, gdy przeglądarka nie rozpoznaje mowy. */
  stt: (audio: Blob) => uploadFile<{ text: string }>('/stt', audio, audio.type || 'audio/webm'),
  /** Dźwięk (MP3) z serwera — tylko dla widocznej odpowiedzi asystenta albo przeglądu dnia. */
  tts: async (source: { messageId: string } | { briefing: true }): Promise<Blob> => {
    let res: Response;
    try {
      res = await fetch('/api/tts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-nova-csrf': '1' },
        body: JSON.stringify(source),
      });
    } catch {
      throw new ApiError(0, 'offline', 'Brak połączenia z serwerem');
    }
    if (!res.ok) throw new ApiError(res.status, 'tts', `Głos niedostępny (${res.status})`);
    return res.blob();
  },
  // ---------- Modele AI i klucze API (klucz tylko wysyłany, nigdy odczytywany) ----------
  modelProviders: () => get<ModelsOverview>('/model/providers'),
  addModelProvider: (body: Record<string, unknown>) =>
    post<ModelsOverview>('/model/providers', body),
  updateModelProvider: (id: string, body: Record<string, unknown>) =>
    request<ModelsOverview>('PATCH', `/model/providers/${id}`, body),
  deleteModelProvider: (id: string) => request<ModelsOverview>('DELETE', `/model/providers/${id}`),
  checkModelProvider: (id: string) => post<ProviderCheckResult>(`/model/providers/${id}/check`),
  addHouseholdModel: (body: Record<string, unknown>) => post<ModelsOverview>('/model/models', body),
  updateHouseholdModel: (id: string, body: Record<string, unknown>) =>
    request<ModelsOverview>('PATCH', `/model/models/${id}`, body),
  deleteHouseholdModel: (id: string) => request<ModelsOverview>('DELETE', `/model/models/${id}`),
  setFxRate: (currency: string, rate: number | null) =>
    request<ModelsOverview>('PUT', '/model/fx', { currency, rate }),
  // ---------- Usługi i koszty ----------
  services: (space: 'all' | 'private' | 'shared', month: string) =>
    get<{ month: string; items: ServiceInfo[] }>(`/services${qs({ space, month })}`),
  service: (id: string, month: string) =>
    get<ServiceInfo & { entries: CostEntryInfo[] }>(`/services/${id}${qs({ month })}`),
  createService: (body: Record<string, unknown>) =>
    post<ServiceInfo & { warnings: string[] }>('/services', body),
  updateService: (id: string, body: Record<string, unknown>) =>
    request<ServiceInfo & { warnings: string[] }>('PATCH', `/services/${id}`, body),
  deleteService: (id: string) => request<{ ok: boolean }>('DELETE', `/services/${id}`),
  setServiceShared: (id: string, shared: boolean) =>
    post<ServiceInfo & { warnings: string[] }>(`/services/${id}/${shared ? 'share' : 'unshare'}`),
  serviceRenewed: (id: string) =>
    post<ServiceInfo & { warnings: string[] }>(`/services/${id}/renewed`),
  addCost: (id: string, body: Record<string, unknown>) =>
    post<{ id: string }>(`/services/${id}/costs`, body),
  deleteCost: (id: string, costId: string) =>
    request<{ ok: boolean }>('DELETE', `/services/${id}/costs/${costId}`),
  importCosts: (id: string, csv: string) =>
    post<{ created: number; duplicates: number }>(`/services/${id}/costs/import`, { csv }),
  costSummary: (space: 'all' | 'private' | 'shared', month: string) =>
    get<CostSummary>(`/costs/summary${qs({ space, month })}`),
  costAdapters: () => get<{ items: CostAdapterInfo[] }>('/cost-adapters'),
  syncCostAdapter: (id: string) =>
    post<{ months: number; items: CostAdapterInfo[] }>(`/cost-adapters/${id}/sync`),

  connections: () => get<{ items: ConnectionInfo[] }>('/connections'),
  startConnection: (provider: string, capabilities: string[]) =>
    post<{ url: string }>(`/connections/${provider}/start`, { capabilities }),
  disconnect: (provider: string) =>
    request<{ disconnected: boolean; providerRevoked: boolean | null }>(
      'DELETE',
      `/connections/${provider}`,
    ),
  /** Slack na żywo — wyniki tylko do wyświetlenia, nie są nigdzie zapisywane. */
  slackLive: (q: Record<string, unknown>) =>
    post<{ items: SlackLiveItem[] }>('/connections/slack/live', q),
  freeBusyGrant: () => get<{ active: boolean }>('/calendar/freebusy-grant'),
  setFreeBusyGrant: (on: boolean) =>
    on
      ? post<{ active: boolean }>('/calendar/freebusy-grant')
      : request<void>('DELETE', '/calendar/freebusy-grant'),
  localEvents: () => get<{ items: LocalEvent[] }>('/calendar/local-events'),
  addLocalEvent: (e: { title: string; startsAt: string; endsAt: string }) =>
    post<{ id: string }>('/calendar/local-events', e),
  deleteLocalEvent: (id: string) => request<void>('DELETE', `/calendar/local-events/${id}`),
  // ---------- Kalendarz z pliku .ics (np. plan zajęć) ----------
  calendarImports: () => get<{ items: CalendarImport[] }>('/calendar/imports'),
  importCalendar: (file: Blob, name: string) =>
    uploadFile<{ import: CalendarImport; skipped: number }>(
      `/calendar/imports?name=${encodeURIComponent(name)}`,
      file,
      'text/calendar',
    ),
  replaceCalendar: (id: string, file: Blob) =>
    uploadFile<{ import: CalendarImport; skipped: number }>(
      `/calendar/imports/${id}`,
      file,
      'text/calendar',
      'PUT',
    ),
  deleteCalendarImport: (id: string) => request<void>('DELETE', `/calendar/imports/${id}`),
  // ---------- Domownicy (konta tylko z zaproszenia) ----------
  householdMembers: () =>
    get<{ canManage: boolean; members: HouseholdMember[] }>('/household/members'),
  inviteMember: (body: { email: string; displayName: string }) =>
    post<{ link: string; expiresAt: string; memberId: string }>('/household/invites', body),
  memberLink: (id: string) =>
    post<{ link: string; expiresAt: string }>(`/household/members/${id}/link`),
  removeMember: (id: string) => request<void>('DELETE', `/household/members/${id}`),
  /** Przedmioty ukryte w planie (np. zajęcia innych grup). */
  setCalendarSubjects: (id: string, excluded: string[]) =>
    request<{ import: CalendarImport }>('PATCH', `/calendar/imports/${id}`, { excluded }),

  reminders: (space: Space) => get<{ items: Reminder[] }>(`/reminders${qs({ space })}`),
  addReminder: (r: { text: string; dueAt: string; space: Space }) =>
    post<{ id: string }>('/reminders', r),
  cancelReminder: (id: string) => request<void>('DELETE', `/reminders/${id}`),

  devices: () => get<{ items: Device[]; serverPublicKey: string }>('/devices'),
  pairingCode: () => post<{ code: string; expiresAt: string }>('/devices/pairing-codes'),
  addGrant: (deviceId: string, capability: GrantCapability, root: string) =>
    post<{ id: string }>(`/devices/${deviceId}/grants`, { capability, root }),
  revokeGrant: (deviceId: string, grantId: string) =>
    request<void>('DELETE', `/devices/${deviceId}/grants/${grantId}`),
  revokeDevice: (deviceId: string) => post<{ ok: boolean }>(`/devices/${deviceId}/revoke`),
};
