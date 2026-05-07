/**
 * Model catalog — discovers what models a provider exposes and what
 * capabilities they support, so the TUI doesn't ship hardcoded lists.
 *
 * For OpenRouter we hit the public `/models` endpoint (no auth needed)
 * and use `supported_parameters` to derive whether the model accepts
 * extended-thinking / reasoning options. Prompt-cache support comes
 * from the same live model rows via cache pricing fields.
 *
 * For Anthropic we hit `/v1/models` with whatever credential the user
 * has (api key or OAuth bearer). Anthropic doesn't advertise reasoning
 * support per model, so we infer it from the model id family.
 *
 * Results are cached on disk under `~/.atlas/cache/<provider>-models.json`
 * with a 24h TTL so startup stays fast and we don't hammer the APIs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import { childLogger } from '../logger.js';
import {
  openCodeRouteForModel,
  stripOpenCodeAtlasPrefix,
  type OpenCodePlan
} from './opencode.js';

const log = childLogger('catalog');

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh';
export type PromptCacheSupport = 'supported' | 'unsupported' | 'unknown';

export type ModelProviderKind =
  | 'openrouter'
  | 'anthropic'
  | 'openai-codex'
  | 'local'
  | 'opencode-zen'
  | 'opencode-go';

export interface ModelInfo {
  /** Provider-native id (no provider/ prefix for native Anthropic). */
  readonly id: string;
  /** Human-friendly label, falls back to id. */
  readonly label: string;
  /** Thinking levels the model supports. Always includes 'off'. */
  readonly thinking: readonly ThinkingLevel[];
  /** Optional context window in tokens (informational). */
  readonly contextWindow?: number;
  /** Whether Atlas can expect cheaper repeated prefixes via provider prompt caching. */
  readonly promptCache: PromptCacheSupport;
  /**
   * Which provider exposes this model. Drives picker grouping and the
   * provider tag in the TUI header.
   */
  readonly provider: ModelProviderKind;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 2;

const cachePath = (provider: string): string =>
  path.join(os.homedir(), '.atlas', 'cache', `${provider}-models.json`);

const isPromptCacheSupport = (value: unknown): value is PromptCacheSupport =>
  value === 'supported' || value === 'unsupported' || value === 'unknown';

const readCache = async (provider: string): Promise<readonly ModelInfo[] | null> => {
  try {
    const raw = await fs.readFile(cachePath(provider), 'utf8');
    const parsed = JSON.parse(raw) as {
      schemaVersion?: number;
      ts?: number;
      models?: ModelInfo[];
    };
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
    if (typeof parsed.ts !== 'number' || !Array.isArray(parsed.models)) return null;
    if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    // Caches written by older builds lack the `provider` discriminator
    // and would be invisible in the grouped picker. Treat them as stale.
    if (
      parsed.models.some(
        (m) => typeof m.provider !== 'string' || !isPromptCacheSupport(m.promptCache)
      )
    ) {
      return null;
    }
    return parsed.models;
  } catch {
    return null;
  }
};

const writeCache = async (provider: string, models: readonly ModelInfo[]): Promise<void> => {
  try {
    await fs.mkdir(path.dirname(cachePath(provider)), { recursive: true });
    await fs.writeFile(
      cachePath(provider),
      JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, ts: Date.now(), models }, null, 2),
      'utf8'
    );
  } catch (e) {
    log.warn({ err: e, provider }, 'failed to write model cache');
  }
};

/** Map OpenRouter `supported_parameters` → thinking levels. */
const openRouterThinking = (supported: readonly string[]): readonly ThinkingLevel[] => {
  const has = (k: string): boolean => supported.some((s) => s.toLowerCase() === k);
  if (has('reasoning') || has('include_reasoning')) {
    return ['off', 'low', 'medium', 'high'];
  }
  return ['off'];
};

const openRouterPromptCache = (
  raw: Record<string, unknown>,
  supported: readonly string[]
): PromptCacheSupport => {
  const normalized = supported.map((s) => s.toLowerCase());
  if (
    normalized.some(
      (s) => s.includes('cache') || s === 'cache_control' || s === 'prompt_cache_key'
    )
  ) {
    return 'supported';
  }
  const pricing = raw['pricing'];
  if (!pricing || typeof pricing !== 'object') return 'unknown';
  const row = pricing as Record<string, unknown>;
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(row, key);
  if (
    has('input_cache_read') ||
    has('input_cache_write') ||
    has('cache_read') ||
    has('cache_write')
  ) {
    return 'supported';
  }
  return 'unsupported';
};

/** Heuristic: map an Anthropic model id family to thinking levels. */
const anthropicThinking = (id: string): readonly ThinkingLevel[] => {
  const m = id.toLowerCase();
  if (/opus-4(\.|-)?[57]/.test(m)) return ['off', 'low', 'medium', 'high', 'xhigh'];
  if (/sonnet-4(\.|-)?5/.test(m)) return ['off', 'low', 'medium', 'high'];
  if (/(opus-4|sonnet-4|haiku-4)/.test(m)) return ['off', 'low', 'medium'];
  if (/claude-3(\.|-)5/.test(m)) return ['off', 'low', 'medium'];
  return ['off'];
};

interface FetchOptions {
  readonly fetch?: typeof fetch;
  readonly forceRefresh?: boolean;
}

interface OpenCodeFetchOptions extends FetchOptions {
  readonly baseUrl?: string;
}

export const fetchOpenRouterModels = async (
  options: FetchOptions = {}
): Promise<Result<readonly ModelInfo[], AtlasError>> => {
  if (!options.forceRefresh) {
    const cached = await readCache('openrouter');
    if (cached) return ok(cached);
  }
  const doFetch = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch('https://openrouter.ai/api/v1/models', {
      headers: { accept: 'application/json' }
    });
  } catch (e) {
    return err(
      atlasError('PROVIDER_NETWORK', 'failed to reach openrouter.ai/api/v1/models', { cause: e })
    );
  }
  if (!res.ok) {
    return err(
      atlasError('PROVIDER_INVALID_RESPONSE', `openrouter /models HTTP ${res.status}`, {
        context: { status: res.status }
      })
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return err(atlasError('PROVIDER_INVALID_RESPONSE', 'openrouter /models bad JSON', { cause: e }));
  }
  const data = (body as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) {
    return err(atlasError('PROVIDER_INVALID_RESPONSE', 'openrouter /models missing data[]'));
  }
  const models: ModelInfo[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r['id'] === 'string' ? r['id'] : null;
    if (!id) continue;
    const supported = Array.isArray(r['supported_parameters'])
      ? (r['supported_parameters'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const ctx =
      typeof r['context_length'] === 'number' ? (r['context_length'] as number) : undefined;
    const name = typeof r['name'] === 'string' ? r['name'] : id;
    models.push({
      id,
      label: name,
      thinking: openRouterThinking(supported),
      promptCache: openRouterPromptCache(r, supported),
      provider: 'openrouter',
      ...(ctx !== undefined ? { contextWindow: ctx } : {})
    });
  }
  // Sort: provider/family/version, with reasoning models first within family.
  models.sort((a, b) => a.id.localeCompare(b.id));
  await writeCache('openrouter', models);
  return ok(models);
};

interface AnthropicAuth {
  readonly kind: 'apiKey' | 'oauth';
  readonly token: string;
}

export const fetchAnthropicModels = async (
  auth: AnthropicAuth,
  options: FetchOptions = {}
): Promise<Result<readonly ModelInfo[], AtlasError>> => {
  if (!options.forceRefresh) {
    const cached = await readCache('anthropic');
    if (cached) return ok(cached);
  }
  const doFetch = options.fetch ?? fetch;
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    accept: 'application/json'
  };
  if (auth.kind === 'apiKey') headers['x-api-key'] = auth.token;
  else {
    headers['authorization'] = `Bearer ${auth.token}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  }
  let res: Response;
  try {
    res = await doFetch('https://api.anthropic.com/v1/models?limit=100', { headers });
  } catch (e) {
    return err(
      atlasError('PROVIDER_NETWORK', 'failed to reach api.anthropic.com/v1/models', { cause: e })
    );
  }
  if (!res.ok) {
    return err(
      atlasError('PROVIDER_INVALID_RESPONSE', `anthropic /models HTTP ${res.status}`, {
        context: { status: res.status }
      })
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return err(atlasError('PROVIDER_INVALID_RESPONSE', 'anthropic /models bad JSON', { cause: e }));
  }
  const data = (body as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) {
    return err(atlasError('PROVIDER_INVALID_RESPONSE', 'anthropic /models missing data[]'));
  }
  const models: ModelInfo[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r['id'] === 'string' ? r['id'] : null;
    if (!id) continue;
    const name = typeof r['display_name'] === 'string' ? r['display_name'] : id;
    models.push({
      id,
      label: name,
      thinking: anthropicThinking(id),
      promptCache: 'supported',
      provider: 'anthropic'
    });
  }
  // Newest first: claude-* sort lexicographically, reverse.
  models.sort((a, b) => b.id.localeCompare(a.id));
  await writeCache('anthropic', models);
  return ok(models);
};

const openCodeThinking = (id: string): readonly ThinkingLevel[] => {
  const m = id.toLowerCase();
  if (/claude/i.test(m)) return anthropicThinking(m);
  if (/gpt-|codex|^o[1-9]/.test(m)) return ['off', 'low', 'medium', 'high'];
  return ['off'];
};

const openCodePromptCache = (raw: Record<string, unknown>): PromptCacheSupport => {
  const fields = [raw['pricing'], raw['cache'], raw['metadata']].filter(
    (v): v is Record<string, unknown> => typeof v === 'object' && v !== null
  );
  for (const row of fields) {
    const keys = Object.keys(row).map((k) => k.toLowerCase());
    if (keys.some((k) => k.includes('cache'))) return 'supported';
  }
  return 'unknown';
};

const rowsFromOpenCodeBody = (body: unknown): readonly unknown[] => {
  if (!body || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (Array.isArray(data)) return data;
  const models = (body as { models?: unknown }).models;
  if (Array.isArray(models)) return models;
  if (models && typeof models === 'object') return Object.values(models as Record<string, unknown>);
  return [];
};

const numberField = (raw: Record<string, unknown>, keys: readonly string[]): number | undefined => {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  const limit = raw['limit'];
  if (limit && typeof limit === 'object') {
    const context = (limit as Record<string, unknown>)['context'];
    if (typeof context === 'number' && Number.isFinite(context)) return context;
  }
  return undefined;
};

const fetchOpenCodeModels = async (
  plan: OpenCodePlan,
  apiKey: string,
  options: OpenCodeFetchOptions = {}
): Promise<Result<readonly ModelInfo[], AtlasError>> => {
  const provider: Extract<ModelProviderKind, 'opencode-zen' | 'opencode-go'> =
    plan === 'zen' ? 'opencode-zen' : 'opencode-go';
  if (!options.forceRefresh) {
    const cached = await readCache(provider);
    if (cached) return ok(cached);
  }
  const baseUrl = (
    options.baseUrl ??
    (plan === 'zen' ? 'https://opencode.ai/zen/v1' : 'https://opencode.ai/zen/go/v1')
  ).replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${baseUrl}/models`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json'
      }
    });
  } catch (e) {
    return err(
      atlasError('PROVIDER_NETWORK', `failed to reach ${provider} /models`, { cause: e })
    );
  }
  if (!res.ok) {
    return err(
      atlasError('PROVIDER_INVALID_RESPONSE', `${provider} /models HTTP ${res.status}`, {
        context: { status: res.status }
      })
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return err(atlasError('PROVIDER_INVALID_RESPONSE', `${provider} /models bad JSON`, { cause: e }));
  }
  const rows = rowsFromOpenCodeBody(body);
  const prefix = plan === 'zen' ? 'opencode' : 'opencode-go';
  const models: ModelInfo[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const raw = row as Record<string, unknown>;
    const rowId =
      typeof raw['id'] === 'string'
        ? raw['id']
        : typeof raw['slug'] === 'string'
          ? raw['slug']
          : null;
    if (!rowId) continue;
    const bare = stripOpenCodeAtlasPrefix(rowId);
    if (!openCodeRouteForModel(plan, bare)) continue;
    const id = `${prefix}/${bare}`;
    const label =
      typeof raw['name'] === 'string'
        ? raw['name']
        : typeof raw['display_name'] === 'string'
          ? raw['display_name']
          : typeof raw['label'] === 'string'
            ? raw['label']
            : bare;
    const contextWindow = numberField(raw, ['context_length', 'context_window', 'contextWindow']);
    models.push({
      id,
      label,
      thinking: openCodeThinking(bare),
      promptCache: openCodePromptCache(raw),
      provider,
      ...(contextWindow !== undefined ? { contextWindow } : {})
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  await writeCache(provider, models);
  return ok(models);
};

export const fetchOpenCodeZenModels = async (
  apiKey: string,
  options: OpenCodeFetchOptions = {}
): Promise<Result<readonly ModelInfo[], AtlasError>> => fetchOpenCodeModels('zen', apiKey, options);

export const fetchOpenCodeGoModels = async (
  apiKey: string,
  options: OpenCodeFetchOptions = {}
): Promise<Result<readonly ModelInfo[], AtlasError>> => fetchOpenCodeModels('go', apiKey, options);

/** Look up thinking levels for a model id, with provider-aware fallback. */
export const thinkingLevelsFor = (
  modelId: string,
  catalog: readonly ModelInfo[]
): readonly ThinkingLevel[] => {
  const exact = catalog.find((m) => m.id === modelId);
  if (exact) return exact.thinking;
  // Fallback: try matching by stripping a leading "provider/" prefix.
  const stripped = modelId.includes('/')
    ? modelId.slice(modelId.lastIndexOf('/') + 1)
    : modelId;
  const matched = catalog.find(
    (m) => m.id === stripped || m.id.endsWith(`/${stripped}`)
  );
  if (matched) return matched.thinking;
  // Last resort: regex heuristic so brand-new model ids still get sensible levels.
  if (/claude/i.test(modelId)) return anthropicThinking(modelId);
  if (/gpt-5|o[1-9]|gemini-2\.5/i.test(modelId)) return ['off', 'low', 'medium', 'high'];
  return ['off'];
};

/**
 * Return the Codex / ChatGPT model catalog for an authenticated user.
 *
 * The ChatGPT-backed Codex backend exposes a private model registry
 * at `/backend-api/codex/models?client_version=...` that's gated by the
 * caller's plan. We query it live so we don't surface API-only models
 * (e.g. `gpt-5-codex`) to ChatGPT-account users — the backend will
 * refuse them at request time with a confusing error otherwise.
 *
 * The hardcoded `codexFallbackCatalog` is only used when the live call
 * fails (network down, parse error, etc.) so /models stays usable.
 */
export const fetchCodexModels = async (
  accessToken: string,
  options: FetchOptions & {
    readonly accountId?: string;
    readonly expiresAt?: number;
  } = {}
): Promise<Result<readonly ModelInfo[], AtlasError>> => {
  if (!accessToken) return ok([]);
  if (typeof options.expiresAt === 'number' && options.expiresAt <= Date.now()) {
    log.warn({ expiresAt: options.expiresAt }, 'codex token expired — hiding catalog');
    return ok([]);
  }
  if (!options.forceRefresh) {
    const cached = await readCache('openai-codex');
    if (cached && cached.length > 0) return ok(cached);
  }

  // The endpoint requires a `client_version` query param and gates the
  // returned model list against it server-side: stale versions get a
  // truncated list (e.g. only `gpt-5.2`). Sending a recent Codex CLI
  // tag unlocks the full set the account is entitled to.
  const url = 'https://chatgpt.com/backend-api/codex/models?client_version=2026.04.20';
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
    'openai-beta': 'responses=experimental',
    originator: 'codex_cli_rs'
  };
  if (options.accountId) headers['chatgpt-account-id'] = options.accountId;

  let models: readonly ModelInfo[];
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      log.warn({ status: res.status }, 'codex /models endpoint failed — using fallback');
      models = codexFallbackCatalog();
    } else {
      const json = (await res.json()) as { models?: ReadonlyArray<Record<string, unknown>> };
      const list = Array.isArray(json.models) ? json.models : [];
      const parsed: ModelInfo[] = [];
      for (const raw of list) {
        const slug = typeof raw['slug'] === 'string' ? raw['slug'] : '';
        if (!slug) continue;
        if (raw['visibility'] === 'hide' || raw['visibility'] === 'none') continue;
        const display = typeof raw['display_name'] === 'string' ? raw['display_name'] : slug;
        const ctx = typeof raw['context_window'] === 'number' ? raw['context_window'] : undefined;
        const efforts = Array.isArray(raw['supported_reasoning_levels'])
          ? (raw['supported_reasoning_levels'] as ReadonlyArray<{ effort?: string }>)
              .map((e) => e?.effort)
              .filter((e): e is string => typeof e === 'string')
          : [];
        const thinking: ThinkingLevel[] = ['off'];
        for (const lvl of ['low', 'medium', 'high', 'xhigh'] as const) {
          if (efforts.includes(lvl)) thinking.push(lvl);
        }
        parsed.push({
          id: slug,
          label: display,
          thinking: thinking.length > 1 ? thinking : codexThinking(slug),
          promptCache: 'supported',
          provider: 'openai-codex',
          ...(ctx !== undefined ? { contextWindow: ctx } : {})
        });
      }
      models = parsed.length > 0 ? parsed : codexFallbackCatalog();
    }
  } catch (e) {
    log.warn({ err: e }, 'codex /models fetch threw — using fallback');
    models = codexFallbackCatalog();
  }

  await writeCache('openai-codex', models);
  return ok(models);
};

/** Heuristic: most chatgpt-backend models accept reasoning effort. */
const codexThinking = (id: string): readonly ThinkingLevel[] => {
  const m = id.toLowerCase();
  if (/mini|nano/.test(m)) return ['off', 'low', 'medium'];
  return ['off', 'low', 'medium', 'high'];
};

/**
 * Curated Codex / ChatGPT catalog. Only used as a fallback when the
 * live `/backend-api/codex/models` call fails. Drops `gpt-5-codex` and
 * `codex-mini-latest` because the chatgpt.com backend rejects them for
 * ChatGPT-account auth ("model not supported when using Codex with a
 * ChatGPT account").
 */
const codexFallbackCatalog = (): readonly ModelInfo[] => [
  {
    id: 'gpt-5',
    label: 'GPT-5',
    thinking: codexThinking('gpt-5'),
    promptCache: 'supported',
    provider: 'openai-codex'
  },
  {
    id: 'gpt-5-mini',
    label: 'GPT-5 Mini',
    thinking: codexThinking('gpt-5-mini'),
    promptCache: 'supported',
    provider: 'openai-codex'
  }
];

/** @deprecated kept for callers that imported the hardcoded list. */
export const codexCatalog = codexFallbackCatalog;
