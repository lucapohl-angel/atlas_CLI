/**
 * Checklist loader — scans `~/.atlas/checklists/*.yaml`, parses,
 * validates, deduplicates by id (newest version wins; on tie, lexically-
 * larger path). Mirrors the templates loader exactly.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import { err, ok, type Result } from '../result.js';
import { ChecklistSchema, type Checklist } from './types.js';

const log = childLogger('checklists');

export const DEFAULT_CHECKLISTS_DIR: string = join(homedir(), '.atlas', 'checklists');

export interface LoadChecklistsOptions {
  readonly dir?: string;
}

export const parseChecklist = (
  raw: string,
  path: string
): Result<Checklist, AtlasError> => {
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (e) {
    return err(
      atlasError('CHECKLIST_PARSE_FAILED', `failed to parse YAML at ${path}`, { cause: e })
    );
  }
  const parsed = ChecklistSchema.safeParse(data);
  if (!parsed.success) {
    return err(
      atlasError(
        'CHECKLIST_PARSE_FAILED',
        `invalid checklist at ${path}: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`
      )
    );
  }
  // Item ids must be unique within a checklist.
  const seen = new Set<string>();
  for (const item of parsed.data.items) {
    if (seen.has(item.id)) {
      return err(
        atlasError(
          'CHECKLIST_PARSE_FAILED',
          `invalid checklist at ${path}: duplicate item id "${item.id}"`
        )
      );
    }
    seen.add(item.id);
  }
  return ok({ ...parsed.data, path });
};

export const loadChecklists = async (
  options: LoadChecklistsOptions = {}
): Promise<Result<readonly Checklist[], AtlasError>> => {
  const dir = options.dir ?? DEFAULT_CHECKLISTS_DIR;
  let entries: string[];
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return ok([]);
    entries = await readdir(dir);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return ok([]);
    return err(
      atlasError('CHECKLIST_PARSE_FAILED', `failed to scan checklists dir ${dir}`, {
        cause: e
      })
    );
  }

  const all: Checklist[] = [];
  for (const entry of entries) {
    if (!/\.ya?ml$/i.test(extname(entry))) continue;
    const path = join(dir, entry);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (e) {
      log.warn({ path, err: e }, 'skipping unreadable checklist');
      continue;
    }
    const r = parseChecklist(raw, path);
    if (!r.ok) {
      log.warn({ path, error: r.error.message }, 'skipping invalid checklist');
      continue;
    }
    all.push(r.value);
  }

  // Newest version wins; tie → lexically larger path.
  const winners = new Map<string, Checklist>();
  for (const c of all) {
    const cur = winners.get(c.id);
    if (
      !cur ||
      c.version > cur.version ||
      (c.version === cur.version && c.path > cur.path)
    ) {
      winners.set(c.id, c);
    }
  }
  return ok([...winners.values()]);
};

export const findChecklist = async (
  id: string,
  options: LoadChecklistsOptions = {}
): Promise<Result<Checklist, AtlasError>> => {
  const r = await loadChecklists(options);
  if (!r.ok) return err(r.error);
  const c = r.value.find((x) => x.id === id);
  if (!c) return err(atlasError('CHECKLIST_NOT_FOUND', `no checklist with id "${id}"`));
  return ok(c);
};
