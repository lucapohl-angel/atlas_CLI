/**
 * SessionStore — durable JSON-on-disk session storage.
 *
 * Layout: `<dir>/<id>.json`. Atomic writes via tmpfile + rename.
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type { Message } from '../providers/types.js';
import type { AuditEntry, SessionRecord } from './types.js';

export const DEFAULT_SESSIONS_DIR: string = join(homedir(), '.atlas', 'sessions');

export const newSessionId = (): string => {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}_${rand}`;
};

export class SessionStore {
  constructor(public readonly dir: string = DEFAULT_SESSIONS_DIR) {}

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async create(init: {
    cwd: string;
    agent?: string;
    model?: string;
    messages?: Message[];
  }): Promise<Result<SessionRecord, AtlasError>> {
    const now = new Date().toISOString();
    const rec: SessionRecord = {
      id: newSessionId(),
      createdAt: now,
      updatedAt: now,
      cwd: init.cwd,
      agent: init.agent,
      model: init.model,
      messages: init.messages ?? [],
      audit: []
    };
    const w = await this.write(rec);
    if (!w.ok) return err(w.error);
    return ok(rec);
  }

  async write(rec: SessionRecord): Promise<Result<void, AtlasError>> {
    try {
      await this.ensureDir();
      rec.updatedAt = new Date().toISOString();
      const target = join(this.dir, `${rec.id}.json`);
      const tmp = `${target}.tmp`;
      await writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
      await rename(tmp, target);
      return ok(undefined);
    } catch (e) {
      return err(atlasError('SESSION_CORRUPT', `failed to write session ${rec.id}`, { cause: e }));
    }
  }

  async load(id: string): Promise<Result<SessionRecord, AtlasError>> {
    try {
      const raw = await readFile(join(this.dir, `${id}.json`), 'utf8');
      return ok(JSON.parse(raw) as SessionRecord);
    } catch (e) {
      const code = (e as { code?: string }).code === 'ENOENT' ? 'SESSION_NOT_FOUND' : 'SESSION_CORRUPT';
      return err(atlasError(code, `failed to load session ${id}`, { cause: e }));
    }
  }

  async list(): Promise<Result<readonly { id: string; updatedAt: string }[], AtlasError>> {
    try {
      const s = await stat(this.dir).catch(() => null);
      if (!s) return ok([]);
      const entries = await readdir(this.dir);
      const out: { id: string; updatedAt: string }[] = [];
      for (const e of entries) {
        if (!e.endsWith('.json')) continue;
        try {
          const r = JSON.parse(await readFile(join(this.dir, e), 'utf8')) as SessionRecord;
          out.push({ id: r.id, updatedAt: r.updatedAt });
        } catch {
          // skip corrupt
        }
      }
      out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return ok(out);
    } catch (e) {
      return err(atlasError('INTERNAL', 'failed to list sessions', { cause: e }));
    }
  }

  async latest(): Promise<Result<SessionRecord | null, AtlasError>> {
    const list = await this.list();
    if (!list.ok) return err(list.error);
    if (list.value.length === 0) return ok(null);
    return this.load(list.value[0]!.id) as Promise<Result<SessionRecord | null, AtlasError>>;
  }

  async remove(id: string): Promise<Result<void, AtlasError>> {
    try {
      await unlink(join(this.dir, `${id}.json`));
      return ok(undefined);
    } catch (e) {
      const code = (e as { code?: string }).code === 'ENOENT' ? 'SESSION_NOT_FOUND' : 'SESSION_CORRUPT';
      return err(atlasError(code, `failed to delete session ${id}`, { cause: e }));
    }
  }
}

export const appendAudit = (rec: SessionRecord, entry: Omit<AuditEntry, 'ts'>): void => {
  rec.audit.push({ ts: new Date().toISOString(), ...entry });
};
