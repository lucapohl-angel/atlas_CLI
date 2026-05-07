/**
 * Atlas config loader.
 *
 * Resolution order (later wins for non-empty values):
 *   1. Schema defaults
 *   2. `~/.atlas/config.yaml` (if present and readable)
 *   3. Environment variables (OPENROUTER_API_KEY, ATLAS_MODEL, ATLAS_CONFIG)
 *
 * All boundaries pass through Zod. File parse errors return a
 * `Result<_, AtlasError>` instead of throwing — the CLI surface decides
 * whether to fall back to defaults or fail loudly.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import { AtlasConfigSchema, type AtlasConfig } from './types.js';

export const DEFAULT_CONFIG_PATH: string = join(homedir(), '.atlas', 'config.yaml');

export interface LoadConfigOptions {
  /** Override config file path (defaults to `~/.atlas/config.yaml`). */
  readonly path?: string;
  /** Override env source (defaults to `process.env`). Useful in tests. */
  readonly env?: NodeJS.ProcessEnv;
}

const isENOENT = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ENOENT';

export const loadConfig = async (
  options: LoadConfigOptions = {}
): Promise<Result<AtlasConfig, AtlasError>> => {
  const env = options.env ?? process.env;
  const path = options.path ?? env['ATLAS_CONFIG'] ?? DEFAULT_CONFIG_PATH;

  let fileData: unknown = {};
  try {
    const raw = await readFile(path, 'utf8');
    fileData = parseYaml(raw) ?? {};
    if (typeof fileData !== 'object' || Array.isArray(fileData)) {
      return err(
        atlasError('CONFIG_INVALID', `config at ${path} must be a YAML object`, {
          context: { path }
        })
      );
    }
  } catch (e) {
    if (!isENOENT(e)) {
      return err(
        atlasError('CONFIG_INVALID', `failed to read config at ${path}`, {
          cause: e,
          context: { path }
        })
      );
    }
    // Missing file is fine — defaults + env are enough to get going.
  }

  const parsed = AtlasConfigSchema.safeParse(fileData);
  if (!parsed.success) {
    return err(
      atlasError('CONFIG_INVALID', `config at ${path} failed validation`, {
        cause: parsed.error,
        context: { path, issues: parsed.error.issues }
      })
    );
  }

  return ok(applyEnvOverrides(parsed.data, env));
};

const applyEnvOverrides = (cfg: AtlasConfig, env: NodeJS.ProcessEnv): AtlasConfig => {
  const apiKey = env['OPENROUTER_API_KEY'] ?? cfg.providers.openrouter.apiKey;
  const model = env['ATLAS_MODEL'] ?? cfg.defaultModel;
  const baseUrl = env['OPENROUTER_BASE_URL'] ?? cfg.providers.openrouter.baseUrl;
  const anthropicKey = env['ANTHROPIC_API_KEY'] ?? cfg.providers.anthropic.apiKey;
  const anthropicBaseUrl = env['ANTHROPIC_BASE_URL'] ?? cfg.providers.anthropic.baseUrl;
  const openCodeZenKey = env['OPENCODE_ZEN_API_KEY'] ?? cfg.providers.opencode.zen.apiKey;
  const openCodeZenBaseUrl =
    env['OPENCODE_ZEN_BASE_URL'] ?? cfg.providers.opencode.zen.baseUrl;
  const openCodeGoKey = env['OPENCODE_GO_API_KEY'] ?? cfg.providers.opencode.go.apiKey;
  const openCodeGoBaseUrl = env['OPENCODE_GO_BASE_URL'] ?? cfg.providers.opencode.go.baseUrl;

  return {
    ...cfg,
    defaultModel: model,
    providers: {
      ...cfg.providers,
      openrouter: {
        ...cfg.providers.openrouter,
        ...(apiKey !== undefined ? { apiKey } : {}),
        baseUrl
      },
      anthropic: {
        ...cfg.providers.anthropic,
        ...(anthropicKey !== undefined ? { apiKey: anthropicKey } : {}),
        baseUrl: anthropicBaseUrl
      },
      opencode: {
        ...cfg.providers.opencode,
        zen: {
          ...cfg.providers.opencode.zen,
          ...(openCodeZenKey !== undefined ? { apiKey: openCodeZenKey } : {}),
          baseUrl: openCodeZenBaseUrl
        },
        go: {
          ...cfg.providers.opencode.go,
          ...(openCodeGoKey !== undefined ? { apiKey: openCodeGoKey } : {}),
          baseUrl: openCodeGoBaseUrl
        }
      }
    }
  };
};
