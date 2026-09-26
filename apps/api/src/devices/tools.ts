import { createHash } from 'node:crypto';
import { CommandParams, type DeviceCapability } from '@nova/contracts';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import { ToolDenied, type ToolContext, type ToolDef } from '../tools/types';
import { DeviceCommandFailed, DeviceDenied } from './broker';

const DeviceId = z.uuid().optional();

async function resolveDevice(ctx: ToolContext, deviceId: string | undefined): Promise<string> {
  if (deviceId) return deviceId;
  const d = await ctx.deps.devices.defaultDevice(ctx.principal.userId);
  if (!d) throw new ToolDenied('device_ambiguous_or_missing');
  return d;
}

/** Wywołanie urządzenia z mapowaniem błędów: odmowa/błąd polecenia => bez ponowień; offline => ponowienie. */
async function run(
  ctx: ToolContext,
  deviceId: string,
  capability: DeviceCapability,
  params: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  try {
    return await ctx.deps.devices.execute(
      ctx.principal,
      ctx.context,
      deviceId,
      capability,
      params,
      {
        taskId: ctx.taskId,
        idempotencyKey,
        correlationId: ctx.correlationId,
      },
    );
  } catch (err) {
    if (err instanceof DeviceDenied) throw new ToolDenied(err.reason);
    if (err instanceof DeviceCommandFailed)
      throw new ToolDenied(`device_error:${err.message.slice(0, 120)}`);
    throw err;
  }
}

async function authorizeDevice(
  ctx: ToolContext,
  deviceId: string | undefined,
  capability: DeviceCapability,
  params: Record<string, unknown>,
) {
  if (!deviceId) return { allow: false, reason: 'no_device' };
  const { decision } = await ctx.deps.devices.check(
    ctx.principal,
    ctx.context,
    deviceId,
    capability,
    params,
  );
  return decision;
}

async function deviceName(ctx: ToolContext, deviceId: string | undefined): Promise<string> {
  if (!deviceId) return 'urządzenie';
  return (await ctx.deps.devices.device(deviceId))?.name ?? 'urządzenie';
}

function readTool(
  name: 'device.files.list' | 'device.files.read' | 'device.git.status' | 'device.git.diff',
  title: string,
  pathKey: 'path' | 'repoPath',
): ToolDef<Record<string, unknown> & { deviceId?: string }> {
  const schema = (CommandParams[name] as z.ZodObject).extend({ deviceId: DeviceId });
  return {
    name,
    capability: name,
    title,
    contexts: ['private_agent', 'user'],
    resultVisibility: 'private',
    params: schema as unknown as z.ZodType<Record<string, unknown> & { deviceId?: string }>,
    readOnly: true,
    requiresApproval: () => false,
    async prepare(ctx, p) {
      return { ...p, deviceId: await resolveDevice(ctx, p.deviceId) };
    },
    async preview(ctx, p) {
      return {
        summary: `${title}: ${String(p[pathKey])}`,
        target: await deviceName(ctx, p.deviceId),
        scope: name,
      };
    },
    authorize: (ctx, p) => {
      const { deviceId, ...params } = p;
      return authorizeDevice(ctx, deviceId, name, params);
    },
    async execute(ctx, p, key) {
      const { deviceId, ...params } = p;
      const out = await run(ctx, await resolveDevice(ctx, deviceId), name, params, key);
      return { summary: `${title}: ${String(p[pathKey])}`, output: out };
    },
  };
}

export const deviceListTool = readTool('device.files.list', 'Lista plików', 'path');
export const deviceReadTool = readTool('device.files.read', 'Odczyt pliku', 'path');
export const deviceGitStatusTool = readTool('device.git.status', 'Git status', 'repoPath');
export const deviceGitDiffTool = readTool('device.git.diff', 'Git diff', 'repoPath');

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

type WriteParams = { deviceId?: string; path: string; content: string; baseSha256?: string | null };

/** Treść bieżąca pobrana przy przygotowaniu — do podglądu diff (krótko żyjąca pamięć procesu). */
const previewCache = new Map<string, { content: string; at: number }>();
const cacheKey = (d: string, p: string, sha: string | null) => `${d}|${p}|${sha ?? 'new'}`;

/**
 * Zapis pliku: ZAWSZE wymaga zgody z podglądem diff. Parametry zamrażają `baseSha256` — Worker odmówi,
 * jeśli plik zmienił się od podglądu. Worker robi kopię zapasową i atomową zamianę.
 */
export const deviceWriteTool: ToolDef<WriteParams> = {
  name: 'device.files.write',
  capability: 'device.files.write',
  title: 'Zapis pliku',
  contexts: ['private_agent', 'user'],
  resultVisibility: 'private',
  params: z.object({
    deviceId: DeviceId,
    path: z.string().min(1).max(1024),
    content: z.string().max(512 * 1024),
    baseSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .optional(),
  }),
  requiresApproval: () => true,
  async prepare(ctx, p) {
    const deviceId = await resolveDevice(ctx, p.deviceId);
    if (p.baseSha256 !== undefined) return { ...p, deviceId };
    // Odczyt bieżącej treści do podglądu (wymaga też grantu odczytu w tym katalogu).
    let base: string | null = null;
    let current = '';
    try {
      const out = await run(
        ctx,
        deviceId,
        'device.files.read',
        { path: p.path },
        `preview:${ctx.stepId ?? 'x'}:${Date.now()}`,
      );
      current = String(out.content ?? '');
      base = String(out.sha256 ?? sha256(current));
    } catch (err) {
      if (!(err instanceof ToolDenied) || !err.reason.includes('not_found')) throw err;
    }
    previewCache.set(cacheKey(deviceId, p.path, base), { content: current, at: Date.now() });
    return { ...p, deviceId, baseSha256: base };
  },
  async preview(ctx, p) {
    const cached = p.deviceId
      ? previewCache.get(cacheKey(p.deviceId, p.path, p.baseSha256 ?? null))
      : undefined;
    const before = cached?.content ?? '';
    const diff = createTwoFilesPatch(
      p.path,
      p.path,
      before,
      p.content,
      p.baseSha256 ? 'obecny' : '(nowy plik)',
      'po zmianie',
      {
        context: 3,
      },
    );
    return {
      summary: `Zapis pliku ${p.path}`,
      target: `${await deviceName(ctx, p.deviceId)}: ${p.path}`,
      scope: 'zapis pliku z kopią zapasową (atomowa zamiana)',
      diff: diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n… (diff skrócony)` : diff,
    };
  },
  authorize: (ctx, p) =>
    authorizeDevice(ctx, p.deviceId, 'device.files.write', {
      path: p.path,
      content: p.content,
      baseSha256: p.baseSha256 ?? null,
    }),
  async execute(ctx, p, key) {
    const deviceId = await resolveDevice(ctx, p.deviceId);
    const out = await run(
      ctx,
      deviceId,
      'device.files.write',
      { path: p.path, content: p.content, baseSha256: p.baseSha256 ?? null },
      key,
    );
    return { summary: `Zapisano ${p.path}`, output: out };
  },
};

export const DEVICE_TOOLS = [
  deviceListTool,
  deviceReadTool,
  deviceGitStatusTool,
  deviceGitDiffTool,
  deviceWriteTool,
] as const;
