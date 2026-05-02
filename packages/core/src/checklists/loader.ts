/**
 * Checklist loader — scans `~/.atlas/checklists/*.yaml`, parses,
 * validates, deduplicates by id (newest version wins; on tie, lexically-
 * larger path). Mirrors the templates loader exactly.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BUILTIN_CHECKLISTS } from '../builtins/checklists.js';
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import { err, ok, type Result } from '../result.js';
import { ChecklistSchema, type Checklist } from './types.js';

const log = childLogger('checklists');

export const DEFAULT_CHECKLISTS_DIR: string = join(homedir(), '.atlas', 'checklists');

export interface LoadChecklistsOptions {
  readonly dir?: string;
  readonly cwd?: string;
  readonly home?: string;
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
  const parseDir = async (dir: string): Promise<Checklist[]> => {
    let entries: string[];
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) return [];
      entries = await readdir(dir);
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return [];
      throw e;
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
    return all;
  };

  try {
    const layers: Checklist[][] = [];
    if (options.dir) {
      layers.push(await parseDir(options.dir));
    } else {
      const builtins: Checklist[] = [];
      for (const c of BUILTIN_CHECKLISTS) {
        const r = parseChecklist(c.content, `builtin:${c.relPath}`);
        if (r.ok) builtins.push(r.value);
      }
      const home = options.home ?? homedir();
      const cwd = options.cwd ?? process.cwd();
      layers.push(builtins);
      layers.push(await parseDir(join(home, '.atlas', 'checklists')));
      layers.push(await parseDir(join(cwd, '.atlas', 'checklists')));
    }

    const merged = new Map<string, Checklist>();
    for (const layer of layers) {
      for (const c of layer) {
        const cur = merged.get(c.id);
        if (!cur) {
          merged.set(c.id, c);
          continue;
        }
        merged.set(c.id, { ...cur, ...c, items: c.items.length > 0 ? c.items : cur.items });
      }
    }
    return ok([...merged.values()]);
  } catch (e) {
    const dir = options.dir ?? DEFAULT_CHECKLISTS_DIR;
    return err(
      atlasError('CHECKLIST_PARSE_FAILED', `failed to scan checklists dir ${dir}`, {
        cause: e
      })
    );
  }
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
