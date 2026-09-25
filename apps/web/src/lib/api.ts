import type {
  Device,
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

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
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
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Błąd ${res.status}`);
  }
  return data as T;
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

export interface ModelStatus {
  mode: 'configured' | 'demo';
  providers: Array<{ name: string; kind: string; configured: boolean; reason: string | null }>;
}

export const api = {
  health: () => get<HealthResponse>('/health'),
  me: () => get<MeResponse>('/me'),
  devUsers: () => get<{ users: DevUser[]; notice: string }>('/auth/dev-users'),
  devLogin: (user: string) => post<{ ok: true }>('/auth/dev-login', { user }),
  logout: () => post<{ ok: true }>('/auth/logout'),

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

  devices: () => get<{ items: Device[]; serverPublicKey: string }>('/devices'),
  pairingCode: () => post<{ code: string; expiresAt: string }>('/devices/pairing-codes'),
  addGrant: (deviceId: string, capability: GrantCapability, root: string) =>
    post<{ id: string }>(`/devices/${deviceId}/grants`, { capability, root }),
  revokeGrant: (deviceId: string, grantId: string) =>
    request<void>('DELETE', `/devices/${deviceId}/grants/${grantId}`),
  revokeDevice: (deviceId: string) => post<{ ok: boolean }>(`/devices/${deviceId}/revoke`),
};
