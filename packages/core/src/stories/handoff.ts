/**
 * Handoff queue. A handoff is a single YAML file under
 * `<repo>/docs/.handoffs/<ts>-<from>-to-<to>.yaml`. It carries a typed
 * payload from one agent to the next. `*next` (and orchestrator code)
 * read this directory to decide what to do.
 *
 * We deliberately keep this primitive small:
 *   - `emitHandoff` writes a new file with `consumed: false`.
 *   - `consumeHandoff` flips the flag to `true` and returns the payload.
 *   - `listHandoffs` returns currently-pending (i.e. `consumed: false`)
 *     handoffs sorted by creation time.
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import { z } from 'zod';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';

const SAFE_AGENT_NAME = /^[a-z][a-z0-9-]*$/;

export const StoryHandoffSchema = z.object({
  fromAgent: z.string().regex(SAFE_AGENT_NAME),
  toAgent: z.string().regex(SAFE_AGENT_NAME),
  storyId: z.string().optional(),
  command: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  consumed: z.boolean().default(false),
  createdAt: z.string()
});
export type StoryHandoff = z.infer<typeof StoryHandoffSchema>;

export interface EmitHandoffInput {
  readonly fromAgent: string;
  readonly toAgent: string;
  readonly storyId?: string;
  readonly command?: string;
  readonly payload?: Record<string, unknown>;
  readonly dir?: string;
  readonly cwd?: string;
  readonly now?: string;
}

const handoffDir = (input: { readonly dir?: string; readonly cwd?: string }): string =>
  input.dir ?? join(input.cwd ?? process.cwd(), 'docs', '.handoffs');

const tsSlug = (iso: string): string => iso.replace(/[^0-9]/g, '').slice(0, 14);

export const emitHandoff = async (
  input: EmitHandoffInput
): Promise<Result<{ readonly path: string; readonly handoff: StoryHandoff }, AtlasError>> => {
  const createdAt = input.now ?? new Date().toISOString();
  const parsed = StoryHandoffSchema.safeParse({
    fromAgent: input.fromAgent,
    toAgent: input.toAgent,
    ...(input.storyId !== undefined ? { storyId: input.storyId } : {}),
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    consumed: false,
    createdAt
  });
  if (!parsed.success) {
    return err(
      atlasError('HANDOFF_PARSE_FAILED', `invalid handoff input`, {
        context: { issues: parsed.error.issues }
      })
    );
  }
  const dir = handoffDir(input);
  const fileName = `${tsSlug(createdAt)}-${parsed.data.fromAgent}-to-${parsed.data.toAgent}.md`;
  const target = join(dir, fileName);
  const md = matter.stringify('\n', parsed.data);
  try {
    await mkdir(dir, { recursive: true });
    const tmp = join(tmpdir(), `atlas-handoff-emit-${randomUUID()}.md`);
    await writeFile(tmp, md, 'utf8');
    await rename(tmp, target);
  } catch (e) {
    return err(atlasError('HANDOFF_PARSE_FAILED', `failed to write handoff`, { cause: e }));
  }
  return ok({ path: target, handoff: parsed.data });
};

export const readHandoff = async (path: string): Promise<Result<StoryHandoff, AtlasError>> => {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      return err(atlasError('HANDOFF_NOT_FOUND', `no handoff at ${path}`));
    }
    return err(atlasError('HANDOFF_PARSE_FAILED', `failed to read handoff`, { cause: e }));
  }
  const parsed = matter(raw);
  const fm = StoryHandoffSchema.safeParse(parsed.data);
  if (!fm.success) {
    return err(
      atlasError('HANDOFF_PARSE_FAILED', `invalid handoff at ${path}`, {
        context: { issues: fm.error.issues }
      })
    );
  }
  return ok(fm.data);
};

export const consumeHandoff = async (
  path: string
): Promise<Result<StoryHandoff, AtlasError>> => {
  const r = await readHandoff(path);
  if (!r.ok) return r;
  if (r.value.consumed) return ok(r.value);
  const next: StoryHandoff = { ...r.value, consumed: true };
  const md = matter.stringify('\n', next);
  try {
    const tmp = join(tmpdir(), `atlas-handoff-consume-${randomUUID()}.md`);
    await writeFile(tmp, md, 'utf8');
    await rename(tmp, path);
  } catch (e) {
    return err(atlasError('HANDOFF_PARSE_FAILED', `failed to write handoff`, { cause: e }));
  }
  return ok(next);
};

export interface ListHandoffsOptions {
  readonly dir?: string;
  readonly cwd?: string;
  readonly toAgent?: string;
  readonly includeConsumed?: boolean;
}

export const listHandoffs = async (
  options: ListHandoffsOptions = {}
): Promise<Result<readonly { readonly path: string; readonly handoff: StoryHandoff }[], AtlasError>> => {
  const dir = handoffDir(options);
  let entries: string[];
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return ok([]);
    entries = await readdir(dir);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return ok([]);
    return err(atlasError('HANDOFF_PARSE_FAILED', `failed to scan handoff dir`, { cause: e }));
  }
  const out: { readonly path: string; readonly handoff: StoryHandoff }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const p = join(dir, entry);
    const r = await readHandoff(p);
    if (!r.ok) continue;
    if (!options.includeConsumed && r.value.consumed) continue;
    if (options.toAgent && r.value.toAgent !== options.toAgent) continue;
    out.push({ path: p, handoff: r.value });
  }
  out.sort((a, b) => a.handoff.createdAt.localeCompare(b.handoff.createdAt));
  return ok(out);
};
