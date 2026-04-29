/**
 * Persist an `AtlasConfig` back to disk as YAML.
 *
 * Used by the in-app setup flow so users can configure Atlas without
 * leaving the TUI. Writes are atomic-ish: target dir is created if
 * missing, file is written via the user's umask. Secrets are stored
 * in plaintext — this matches how Claude Code, OpenCode, and Hermes
 * keep their config; it lives under `~/.atlas/` which the user owns.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { dump as dumpYaml } from 'js-yaml';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type { AtlasConfig } from './types.js';

export const DEFAULT_CONFIG_PATH: string = join(homedir(), '.atlas', 'config.yaml');

export interface SaveConfigOptions {
  readonly path?: string;
}

export const saveConfig = async (
  cfg: AtlasConfig,
  options: SaveConfigOptions = {}
): Promise<Result<{ readonly path: string }, AtlasError>> => {
  const path = options.path ?? DEFAULT_CONFIG_PATH;
  try {
    await mkdir(dirname(path), { recursive: true });
    const yaml = dumpYaml(stripUndefined(cfg), { lineWidth: 120, noRefs: true });
    await writeFile(path, yaml, 'utf8');
    return ok({ path });
  } catch (e) {
    return err(
      atlasError('CONFIG_INVALID', `failed to write config at ${path}`, {
        cause: e,
        context: { path }
      })
    );
  }
};

/** Recursively drop `undefined` keys so the YAML stays clean. */
const stripUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
};
