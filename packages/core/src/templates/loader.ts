/**
 * Template loader — scans `~/.atlas/templates/*.yaml`, parses, validates,
 * deduplicates by id (newest version wins; on tie, lexically-newer path).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import { err, ok, type Result } from '../result.js';
import { TemplateSchema, type Template } from './types.js';

const log = childLogger('templates');

export const DEFAULT_TEMPLATES_DIR: string = join(homedir(), '.atlas', 'templates');

export interface LoadTemplatesOptions {
  readonly dir?: string;
}

export const parseTemplate = (
  raw: string,
  path: string
): Result<Template, AtlasError> => {
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (e) {
    return err(
      atlasError('TEMPLATE_PARSE_FAILED', `failed to parse YAML at ${path}`, { cause: e })
    );
  }
  const parsed = TemplateSchema.safeParse(data);
  if (!parsed.success) {
    return err(
      atlasError(
        'TEMPLATE_PARSE_FAILED',
        `invalid template at ${path}: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`
      )
    );
  }
  return ok({ ...parsed.data, path });
};

export const loadTemplates = async (
  options: LoadTemplatesOptions = {}
): Promise<Result<readonly Template[], AtlasError>> => {
  const dir = options.dir ?? DEFAULT_TEMPLATES_DIR;
  let entries: string[];
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return ok([]);
    entries = await readdir(dir);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return ok([]);
    return err(
      atlasError('TEMPLATE_PARSE_FAILED', `failed to scan templates dir ${dir}`, { cause: e })
    );
  }

  const all: Template[] = [];
  for (const entry of entries) {
    if (!/\.ya?ml$/i.test(extname(entry))) continue;
    const path = join(dir, entry);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (e) {
      log.warn({ path, err: e }, 'skipping unreadable template');
      continue;
    }
    const r = parseTemplate(raw, path);
    if (!r.ok) {
      log.warn({ path, error: r.error.message }, 'skipping invalid template');
      continue;
    }
    all.push(r.value);
  }

  // Deduplicate by id: newest version wins; on tie, the lexically larger
  // path wins (mirrors the skill loader). All on-disk copies remain.
  const winners = new Map<string, Template>();
  for (const t of all) {
    const cur = winners.get(t.id);
    if (
      !cur ||
      t.version > cur.version ||
      (t.version === cur.version && t.path > cur.path)
    ) {
      winners.set(t.id, t);
    }
  }
  return ok([...winners.values()]);
};

export const findTemplate = async (
  id: string,
  options: LoadTemplatesOptions = {}
): Promise<Result<Template, AtlasError>> => {
  const r = await loadTemplates(options);
  if (!r.ok) return err(r.error);
  const t = r.value.find((x) => x.id === id);
  if (!t) return err(atlasError('TEMPLATE_NOT_FOUND', `no template with id "${id}"`));
  return ok(t);
};
