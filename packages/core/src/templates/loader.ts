/**
 * Template loader — scans `~/.atlas/templates/*.yaml`, parses, validates,
 * deduplicates by id (newest version wins; on tie, lexically-newer path).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BUILTIN_TEMPLATES } from '../builtins/templates.js';
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import { err, ok, type Result } from '../result.js';
import { TemplateSchema, type Template } from './types.js';

const log = childLogger('templates');

export const DEFAULT_TEMPLATES_DIR: string = join(homedir(), '.atlas', 'templates');

export interface LoadTemplatesOptions {
  readonly dir?: string;
  readonly cwd?: string;
  readonly home?: string;
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
  const parseDir = async (dir: string): Promise<Template[]> => {
    let entries: string[];
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) return [];
      entries = await readdir(dir);
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return [];
      throw e;
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
    return all;
  };

  try {
    const layers: Template[][] = [];
    if (options.dir) {
      layers.push(await parseDir(options.dir));
    } else {
      const builtins: Template[] = [];
      for (const t of BUILTIN_TEMPLATES) {
        const r = parseTemplate(t.content, `builtin:${t.relPath}`);
        if (r.ok) builtins.push(r.value);
      }
      const home = options.home ?? homedir();
      const cwd = options.cwd ?? process.cwd();
      layers.push(builtins);
      layers.push(await parseDir(join(home, '.atlas', 'templates')));
      layers.push(await parseDir(join(cwd, '.atlas', 'templates')));
    }

    // Overlay merge: project wins over user wins over built-ins.
    const merged = new Map<string, Template>();
    for (const layer of layers) {
      for (const t of layer) {
        const cur = merged.get(t.id);
        if (!cur) {
          merged.set(t.id, t);
          continue;
        }
        merged.set(t.id, { ...cur, ...t, sections: t.sections.length > 0 ? t.sections : cur.sections });
      }
    }
    return ok([...merged.values()]);
  } catch (e) {
    const dir = options.dir ?? DEFAULT_TEMPLATES_DIR;
    return err(
      atlasError('TEMPLATE_PARSE_FAILED', `failed to scan templates dir ${dir}`, { cause: e })
    );
  }
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
