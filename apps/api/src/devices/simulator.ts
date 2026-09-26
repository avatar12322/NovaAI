import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  CommandParams,
  CommandPayload,
  GRANT_FOR,
  GrantsPayload,
  helloMessage,
  ServerFrame,
  WORKER_PROTOCOL_VERSION,
  type GrantCapability,
  type PairResponse,
  type ResultPayload,
} from '@nova/contracts';
import WebSocket from 'ws';
import { publicKeyFromRaw, rawPublicKey, signText, verifyText } from './keys';

const pexec = promisify(execFile);
const MAX_READ = 256 * 1024;

interface LocalPolicy {
  /** Katalogi udostępnione lokalnie przez właściciela urządzenia (niezależnie od serwera). */
  roots: string[];
  capabilities: GrantCapability[];
}

class Denied extends Error {}

/**
 * Symulator Workera — referencyjna implementacja protokołu v1 w TS (testy i demo bez Windowsa).
 * Te same reguły implementuje Worker w Rust (workers/windows). NIE jest to Worker produkcyjny.
 */
export class WorkerSimulator {
  readonly deviceKey: KeyObject;
  deviceId: string | null = null;
  serverKey: KeyObject | null = null;
  grants: GrantsPayload['grants'] = [];
  ws: WebSocket | null = null;
  readonly executed: Array<{ capability: string; params: Record<string, unknown> }> = [];
  readonly rejected: string[] = [];
  private readonly seen = new Map<string, ResultPayload>();
  closeCode: number | null = null;

  constructor(
    private readonly baseUrl: string,
    public policy: LocalPolicy,
    private readonly stateDir: string,
    opts: { deviceKey?: KeyObject } = {},
  ) {
    this.deviceKey = opts.deviceKey ?? generateKeyPairSync('ed25519').privateKey;
  }

  get publicKeyB64(): string {
    return rawPublicKey(this.deviceKey).toString('base64');
  }

  async pair(code: string, name = 'Symulator'): Promise<PairResponse> {
    const res = await fetch(`${this.baseUrl}/api/device-link/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        name,
        platform: 'simulator',
        publicKey: this.publicKeyB64,
        protocolVersion: WORKER_PROTOCOL_VERSION,
      }),
    });
    if (res.status !== 201) throw new Error(`pair failed: ${res.status}`);
    const body = (await res.json()) as PairResponse;
    this.deviceId = body.deviceId;
    // Przypięcie klucza serwera — każde polecenie musi być nim podpisane.
    this.serverKey = publicKeyFromRaw(Buffer.from(body.serverPublicKey, 'base64'));
    return body;
  }

  /** Połączenie wychodzące; rozwiązuje się po `welcome` (lub odrzuca po zamknięciu). */
  connect(opts: { signWith?: KeyObject } = {}): Promise<void> {
    const url = `${this.baseUrl.replace(/^http/, 'ws')}/api/device-link/connect`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.closeCode = null;
    return new Promise((resolve, reject) => {
      ws.on('message', (data) => {
        void this.onFrame(data.toString(), opts, resolve).catch(() => undefined);
      });
      ws.on('close', (code) => {
        this.closeCode = code;
        reject(new Error(`closed ${code}`));
      });
      ws.on('error', reject);
    });
  }

  close(): void {
    this.ws?.close();
  }

  private send(obj: unknown): void {
    this.ws?.send(JSON.stringify(obj));
  }

  private async onFrame(
    raw: string,
    opts: { signWith?: KeyObject },
    ready: () => void,
  ): Promise<void> {
    const parsed = ServerFrame.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const f = parsed.data;
    if (f.type === 'challenge') {
      const key = opts.signWith ?? this.deviceKey;
      this.send({
        type: 'hello',
        deviceId: this.deviceId,
        nonce: f.nonce,
        sig: signText(key, helloMessage(this.deviceId!, f.nonce)),
        workerVersion: 'sim-0.1',
        platform: 'simulator',
      });
    } else if (f.type === 'welcome') {
      ready();
    } else if (f.type === 'grants') {
      if (!this.serverKey || !verifyText(this.serverKey, f.payload, f.sig)) {
        this.rejected.push('grants_bad_signature');
        return;
      }
      const g = GrantsPayload.safeParse(JSON.parse(f.payload));
      if (g.success && g.data.deviceId === this.deviceId) this.grants = g.data.grants;
    } else if (f.type === 'command') {
      await this.onCommand(f.payload, f.sig);
    }
  }

  private async onCommand(payloadText: string, sig: string): Promise<void> {
    if (!this.serverKey || !verifyText(this.serverKey, payloadText, sig)) {
      this.rejected.push('bad_signature');
      return; // Niepodpisane/obce polecenie: brak wykonania i brak odpowiedzi.
    }
    const p = CommandPayload.safeParse(JSON.parse(payloadText));
    if (!p.success) {
      this.rejected.push('bad_payload');
      return;
    }
    const cmd = p.data;
    const reply = (
      r: Omit<ResultPayload, 'v' | 'commandId' | 'idempotencyKey' | 'completedAt'>,
    ) => {
      const result: ResultPayload = {
        v: WORKER_PROTOCOL_VERSION,
        commandId: cmd.commandId,
        idempotencyKey: cmd.idempotencyKey,
        completedAt: new Date().toISOString(),
        ...r,
      };
      if (r.status === 'ok') this.seen.set(cmd.idempotencyKey, result);
      const json = JSON.stringify(result);
      this.send({ type: 'result', payload: json, sig: signText(this.deviceKey, json) });
    };
    try {
      if (cmd.deviceId !== this.deviceId) throw new Denied('wrong_device');
      if (Date.parse(cmd.deadline) < Date.now()) throw new Denied('expired');
      const prev = this.seen.get(cmd.idempotencyKey);
      if (prev) {
        reply({
          status: prev.status,
          output: { ...(prev.output ?? {}), replay: true },
          error: prev.error,
        });
        return;
      }
      const output = await this.execute(cmd);
      this.executed.push({ capability: cmd.capability, params: cmd.params });
      reply({ status: 'ok', output, error: null });
    } catch (err) {
      const denied = err instanceof Denied;
      if (denied) this.rejected.push(err.message);
      reply({
        status: denied ? 'denied' : 'error',
        output: null,
        error: (err as Error).message.slice(0, 500),
      });
    }
  }

  /** Katalogi dozwolone dla zdolności: lokalna polityka ∩ podpisane granty serwera, kanonicznie. */
  private async allowedRoots(grant: GrantCapability): Promise<string[]> {
    if (!this.policy.capabilities.includes(grant))
      throw new Denied('capability_not_in_local_policy');
    const server = this.grants.filter((g) => g.capability === grant).map((g) => g.root);
    const out: string[] = [];
    for (const local of this.policy.roots) {
      const lr = await realpath(local);
      for (const sr of server) {
        if (!isAbsolute(sr)) continue;
        const srr = await realpath(sr).catch(() => null);
        if (!srr) continue;
        // Część wspólna: węższy z dwóch katalogów, jeśli jeden zawiera drugi.
        if (within(srr, lr)) out.push(srr);
        else if (within(lr, srr)) out.push(lr);
      }
    }
    if (!out.length) throw new Denied('no_grant_for_capability');
    return out;
  }

  /** Kanonikalizacja ścieżki i kontrola ucieczki (symlink/junction, ..). */
  private async resolve(path: string, grant: GrantCapability, forWrite = false): Promise<string> {
    if (!isAbsolute(path) || path.split(/[\\/]/).includes('..'))
      throw new Denied('path_not_allowed');
    const roots = await this.allowedRoots(grant);
    let real: string;
    if (forWrite) {
      const parent = await realpath(dirname(path)).catch(() => {
        throw new Denied('parent_missing');
      });
      real = join(parent, basename(path));
      const st = await lstat(real).catch(() => null);
      if (st?.isSymbolicLink()) throw new Denied('symlink_target');
    } else {
      real = await realpath(path).catch(() => {
        throw new Error('not_found');
      });
    }
    if (!roots.some((r) => within(real, r))) throw new Denied('path_outside_root');
    return real;
  }

  private async execute(cmd: CommandPayload): Promise<Record<string, unknown>> {
    const schema = CommandParams[cmd.capability];
    const params = schema.safeParse(cmd.params);
    if (!params.success) throw new Denied('invalid_params');
    const grant = GRANT_FOR[cmd.capability];
    switch (cmd.capability) {
      case 'device.files.list': {
        const dir = await this.resolve(String(cmd.params.path), grant);
        const entries = await readdir(dir, { withFileTypes: true });
        const out = [];
        for (const e of entries.slice(0, 1000)) {
          const st = await lstat(join(dir, e.name));
          out.push({
            name: e.name,
            kind: st.isSymbolicLink() ? 'link' : e.isDirectory() ? 'dir' : 'file',
            size: st.size,
            modified: st.mtime.toISOString(),
          });
        }
        return { path: dir, entries: out };
      }
      case 'device.files.read': {
        const file = await this.resolve(String(cmd.params.path), grant);
        const st = await stat(file);
        if (!st.isFile()) throw new Denied('not_a_file');
        if (st.size > MAX_READ) throw new Denied('file_too_large');
        const buf = await readFile(file);
        return { content: buf.toString('utf8'), sha256: sha(buf), size: st.size };
      }
      case 'device.files.write': {
        const p = CommandParams['device.files.write'].parse(cmd.params);
        const file = await this.resolve(p.path, grant, true);
        const cur = await readFile(file).catch(() => null);
        if (p.baseSha256 === null && cur) throw new Denied('base_changed');
        if (p.baseSha256 !== null && (!cur || sha(cur) !== p.baseSha256))
          throw new Denied('base_changed');
        let backupPath: string | null = null;
        if (cur) {
          // Kopia odzyskiwania POZA udostępnionym katalogiem (w katalogu stanu Workera).
          const dir = join(this.stateDir, 'backups');
          await mkdir(dir, { recursive: true });
          backupPath = join(dir, `${Date.now()}-${sha(cur).slice(0, 8)}-${basename(file)}`);
          await copyFile(file, backupPath);
        }
        const tmp = join(
          dirname(file),
          `.${basename(file)}.nova-tmp-${randomBytes(4).toString('hex')}`,
        );
        const fh = await open(tmp, 'wx');
        try {
          await fh.writeFile(p.content, 'utf8');
          await fh.sync();
        } finally {
          await fh.close();
        }
        await rename(tmp, file); // atomowa zamiana
        return {
          path: file,
          size: Buffer.byteLength(p.content),
          sha256: sha(Buffer.from(p.content)),
          backupPath,
        };
      }
      case 'device.git.status':
      case 'device.git.diff': {
        const repo = await this.resolve(String(cmd.params.repoPath), grant);
        const args =
          cmd.capability === 'device.git.status'
            ? ['-C', repo, 'status', '--porcelain=v1', '--branch']
            : ['-C', repo, 'diff', '--no-color', '--no-ext-diff'];
        const { stdout } = await pexec('git', args, {
          timeout: 10_000,
          maxBuffer: MAX_READ,
          env: { PATH: process.env.PATH ?? '', GIT_TERMINAL_PROMPT: '0' },
        });
        return { output: stdout };
      }
    }
  }
}

function sha(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
