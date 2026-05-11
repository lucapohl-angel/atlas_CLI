import {
  fetchAnthropicModels,
  fetchCodexModels,
  fetchOpenCodeGoModels,
  fetchOpenCodeZenModels,
  fetchOpenRouterModels,
  listLocalModels,
  loadClaudeCodeCredentials,
  probeLocalProvider,
  thinkingLevelsFor,
  type AtlasConfig,
  type ModelInfo,
  type ModelProviderKind,
  type PromptCacheSupport,
  type ThinkingLevel,
} from '@atlas/core';

export interface VsCodeModelSummary {
  readonly id: string;
  readonly label: string;
  readonly provider: ModelProviderKind;
  readonly providerLabel: string;
  readonly contextWindow: number | null;
  readonly promptCache: PromptCacheSupport;
  readonly promptCacheLabel: string;
  readonly thinking: readonly ThinkingLevel[];
  readonly supportsVision: boolean;
  readonly active: boolean;
  readonly configuredDefault: boolean;
  readonly fallback: boolean;
  readonly custom: boolean;
  readonly selectable: boolean;
  readonly note: string | null;
}

export interface VsCodeModelCatalogDiagnostic {
  readonly provider: ModelProviderKind;
  readonly providerLabel: string;
  readonly status: 'loaded' | 'skipped' | 'fallback' | 'error';
  readonly count: number;
  readonly message: string;
}

export interface VsCodeModelCatalogLoadResult {
  readonly models: readonly ModelInfo[];
  readonly diagnostics: readonly VsCodeModelCatalogDiagnostic[];
}

interface LoadCatalogOptions {
  readonly forceRefresh?: boolean;
}

interface BuildSummaryOptions {
  readonly activeModel: string;
  readonly activeProvider: ModelProviderKind;
}

const PROVIDER_LABELS: Readonly<Record<ModelProviderKind, string>> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  'openai-codex': 'ChatGPT / Codex',
  local: 'Local',
  'opencode-zen': 'OpenCode Zen',
  'opencode-go': 'OpenCode Go',
};

const DEFAULT_PROVIDER_KIND: Readonly<Record<AtlasConfig['defaultProvider'], ModelProviderKind>> = {
  openrouter: 'openrouter',
  anthropic: 'anthropic',
  'openai-codex': 'openai-codex',
  local: 'local',
  'opencode-zen': 'opencode-zen',
  'opencode-go': 'opencode-go',
};

export const providerLabel = (provider: ModelProviderKind): string => PROVIDER_LABELS[provider];

export const defaultProviderForModelProvider = (
  provider: ModelProviderKind,
): AtlasConfig['defaultProvider'] | null => {
  return provider;
};

export const loadVsCodeModelCatalog = async (
  cfg: AtlasConfig,
  options: LoadCatalogOptions = {},
): Promise<readonly ModelInfo[]> => {
  const result = await loadVsCodeModelCatalogWithDiagnostics(cfg, options);
  return result.models;
};

export const loadVsCodeModelCatalogWithDiagnostics = async (
  cfg: AtlasConfig,
  options: LoadCatalogOptions = {},
): Promise<VsCodeModelCatalogLoadResult> => {
  const tasks: Promise<{
    readonly models: readonly ModelInfo[];
    readonly diagnostic: VsCodeModelCatalogDiagnostic;
  }>[] = [];

  const loadProvider = async (
    provider: ModelProviderKind,
    loader: () => Promise<readonly ModelInfo[]>,
    skippedMessage: string | null = null,
  ): Promise<{
    readonly models: readonly ModelInfo[];
    readonly diagnostic: VsCodeModelCatalogDiagnostic;
  }> => {
    if (skippedMessage) {
      return {
        models: [],
        diagnostic: {
          provider,
          providerLabel: providerLabel(provider),
          status: 'skipped',
          count: 0,
          message: skippedMessage,
        },
      };
    }
    try {
      const models = await loader();
      return {
        models,
        diagnostic: {
          provider,
          providerLabel: providerLabel(provider),
          status: models.length > 0 ? 'loaded' : 'fallback',
          count: models.length,
          message: models.length > 0 ? `${models.length} models loaded.` : 'No live model rows returned.',
        },
      };
    } catch (error) {
      return {
        models: [],
        diagnostic: {
          provider,
          providerLabel: providerLabel(provider),
          status: 'error',
          count: 0,
          message: error instanceof Error ? error.message : 'Model catalog failed.',
        },
      };
    }
  };

  tasks.push(loadProvider(
    'openrouter',
    async () => {
      const rows = await fetchOpenRouterModels({ forceRefresh: options.forceRefresh });
      if (!rows.ok) throw rows.error;
      return rows.value;
    },
    cfg.providers.openrouter.apiKey ? null : 'OpenRouter API key is not configured.',
  ));

  const anthropicKey = cfg.providers.anthropic.apiKey;
  tasks.push(loadProvider(
    'anthropic',
    async () => {
      if (anthropicKey) {
        const rows = await fetchAnthropicModels({ kind: 'apiKey', token: anthropicKey }, options);
        if (!rows.ok) throw rows.error;
        return rows.value;
      }
      const creds = await loadClaudeCodeCredentials(
        cfg.providers.anthropic.claudeCodeCredentialsPath
          ? { path: cfg.providers.anthropic.claudeCodeCredentialsPath }
          : {},
      );
      if (!creds.ok) throw creds.error;
      const models = await fetchAnthropicModels({ kind: 'oauth', token: creds.value.accessToken }, options);
      if (!models.ok) throw models.error;
      return models.value;
    },
    anthropicKey || cfg.providers.anthropic.useClaudeCodeOauth
      ? null
      : 'Anthropic API key and Claude Code OAuth are both disabled.',
  ));

  const codexAuth = cfg.providers.openai.codex;
  const openAiSkippedMessage = cfg.providers.openai.authMode === 'apiKey'
    ? (cfg.providers.openai.apiKey ? null : 'OpenAI auth mode is API key, but no API key is configured.')
    : cfg.providers.openai.authMode === 'oauth'
      ? (codexAuth.accessToken ? null : 'OpenAI auth mode is OAuth, but ChatGPT / Codex is not signed in.')
      : (cfg.providers.openai.apiKey || codexAuth.accessToken ? null : 'OpenAI API key and ChatGPT OAuth are both missing.');
  tasks.push(loadProvider(
    'openai-codex',
    async () => {
      if (cfg.providers.openai.authMode !== 'oauth' && cfg.providers.openai.apiKey) {
        return fetchOpenAiApiModels(cfg.providers.openai.apiKey, {
          baseUrl: cfg.providers.openai.apiBaseUrl,
          forceRefresh: options.forceRefresh,
        });
      }
      const codexOptions: { readonly accountId?: string; readonly expiresAt?: number; readonly forceRefresh?: boolean } = {
        ...(codexAuth.accountId ? { accountId: codexAuth.accountId } : {}),
        ...(typeof codexAuth.expiresAt === 'number' ? { expiresAt: codexAuth.expiresAt } : {}),
        ...(options.forceRefresh !== undefined ? { forceRefresh: options.forceRefresh } : {}),
      };
      const rows = await fetchCodexModels(codexAuth.accessToken ?? '', codexOptions);
      if (!rows.ok) throw rows.error;
      return rows.value;
    },
    openAiSkippedMessage,
  ));

  const zenKey = cfg.providers.opencode.zen.apiKey;
  tasks.push(loadProvider(
    'opencode-zen',
    async () => {
      const rows = await fetchOpenCodeZenModels(zenKey ?? '', {
        baseUrl: cfg.providers.opencode.zen.baseUrl,
        forceRefresh: options.forceRefresh,
      });
      if (!rows.ok) throw rows.error;
      return rows.value;
    },
    zenKey ? null : 'OpenCode Zen API key is not configured.',
  ));

  const goKey = cfg.providers.opencode.go.apiKey;
  tasks.push(loadProvider(
    'opencode-go',
    async () => {
      const rows = await fetchOpenCodeGoModels(goKey ?? '', {
        baseUrl: cfg.providers.opencode.go.baseUrl,
        forceRefresh: options.forceRefresh,
      });
      if (!rows.ok) throw rows.error;
      return rows.value;
    },
    goKey ? null : 'OpenCode Go API key is not configured.',
  ));

  const local = cfg.providers.local;
  tasks.push(loadProvider(
    'local',
    async () => {
      const reachable = await probeLocalProvider(local.baseUrl);
      if (!reachable) return localPresetRows([]);
      const pulledIds = await listLocalModels(local.baseUrl, local.apiKey ? { apiKey: local.apiKey } : {});
      return localPresetRows(pulledIds ?? []);
    },
    local.autoDetect || cfg.defaultProvider === 'local'
      ? null
      : 'Local auto-detect is disabled.',
  ));

  const results = await Promise.all(tasks);
  const merged: ModelInfo[] = [];
  const diagnostics: VsCodeModelCatalogDiagnostic[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    diagnostics.push(result.diagnostic);
    for (const model of result.models) {
      const key = modelKey(model.provider, model.id);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(model);
    }
  }
  return { models: merged, diagnostics };
};

export const buildVsCodeModelSummary = (
  cfg: AtlasConfig,
  catalog: readonly ModelInfo[],
  options: BuildSummaryOptions,
): readonly VsCodeModelSummary[] => {
  const rows = new Map<string, ModelInfo>();
  for (const model of catalog) rows.set(modelKey(model.provider, model.id), model);
  const fallbackKeys = new Set<string>();
  const customKeys = new Set<string>();
  const notes = new Map<string, string | null>();

  const ensure = (
    id: string,
    provider: ModelProviderKind,
    label: string,
    flags: { readonly fallback?: boolean; readonly custom?: boolean; readonly note?: string | null } = {},
  ): void => {
    const key = modelKey(provider, id);
    if (!rows.has(key)) {
      rows.set(key, {
        id,
        label,
        provider,
        promptCache: provider === 'local' ? 'unsupported' : 'unknown',
        thinking: thinkingLevelsFor(id, catalog),
        supportsVision: false,
      });
    }
    if (flags.fallback) fallbackKeys.add(key);
    if (flags.custom) customKeys.add(key);
    if (flags.note !== undefined) notes.set(key, flags.note);
  };

  const configuredProvider = DEFAULT_PROVIDER_KIND[cfg.defaultProvider];

  const isProviderConfigured = (provider: ModelProviderKind): boolean => {
    switch (provider) {
      case 'openrouter':
        return cfg.providers.openrouter.apiKey !== undefined;
      case 'anthropic':
        return cfg.providers.anthropic.apiKey !== undefined || cfg.providers.anthropic.useClaudeCodeOauth;
      case 'openai-codex':
        return cfg.providers.openai.apiKey !== undefined || cfg.providers.openai.codex.accessToken !== undefined;
      case 'opencode-zen':
        return cfg.providers.opencode.zen.apiKey !== undefined;
      case 'opencode-go':
        return cfg.providers.opencode.go.apiKey !== undefined;
      case 'local':
        return true;
    }
  };

  if (isProviderConfigured(configuredProvider)) {
    ensure(cfg.defaultModel, configuredProvider, cfg.defaultModel);
  }
  if (isProviderConfigured(options.activeProvider)) {
    ensure(options.activeModel, options.activeProvider, options.activeModel);
  }
  for (const model of cfg.fallbackModels) {
    const provider = inferModelProvider(model, configuredProvider, catalog);
    if (isProviderConfigured(provider)) {
      ensure(model, provider, model, { fallback: true });
    }
  }
  if (isProviderConfigured('openrouter')) {
    for (const model of cfg.providers.openrouter.customModels) {
      ensure(model, 'openrouter', model, { custom: true });
    }
  }
  for (const model of cfg.providers.local.customModels) {
    ensure(model, 'local', model, { custom: true });
  }
  if (isProviderConfigured('opencode-zen')) {
    for (const model of cfg.providers.opencode.zen.customModels) {
      const id = model.startsWith('opencode/') ? model : `opencode/${model}`;
      ensure(id, 'opencode-zen', id, { custom: true });
    }
  }
  if (isProviderConfigured('opencode-go')) {
    for (const model of cfg.providers.opencode.go.customModels) {
      const id = model.startsWith('opencode-go/') ? model : `opencode-go/${model}`;
      ensure(id, 'opencode-go', id, { custom: true });
    }
  }

  return [...rows.values()]
    .map((model): VsCodeModelSummary => {
      const key = modelKey(model.provider, model.id);
      const active = model.id === options.activeModel && model.provider === options.activeProvider;
      const configuredDefault = model.id === cfg.defaultModel && model.provider === configuredProvider;
      return {
        id: model.id,
        label: model.label || model.id,
        provider: model.provider,
        providerLabel: providerLabel(model.provider),
        contextWindow: model.contextWindow ?? null,
        promptCache: model.promptCache,
        promptCacheLabel: cacheLabel(model.promptCache),
        thinking: model.thinking.length > 0 ? model.thinking : ['off'],
        supportsVision: model.supportsVision,
        active,
        configuredDefault,
        fallback: fallbackKeys.has(key),
        custom: customKeys.has(key),
        selectable: true,
        note: notes.get(key) ?? null,
      };
    })
    .sort(compareModelSummaries);
};

const fetchOpenAiApiModels = async (
  apiKey: string,
  options: { readonly baseUrl: string; readonly forceRefresh?: boolean },
): Promise<readonly ModelInfo[]> => {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`OpenAI /models failed: ${response.status}`);
  }
  const body = await response.json() as unknown;
  const ids = parseOpenAiModelIds(body);
  const rows = ids
    .filter((id) => /^(gpt-|o[1-9]|codex-)/i.test(id))
    .map((id): ModelInfo => ({
      id,
      label: id,
      provider: 'openai-codex',
      promptCache: 'unknown',
      thinking: thinkingLevelsFor(id, []),
      supportsVision: codexVision(id),
    }));
  return rows.length > 0 ? rows : openAiApiFallbackCatalog();
};

const parseOpenAiModelIds = (body: unknown): readonly string[] => {
  if (!body || typeof body !== 'object') return [];
  const data = (body as { readonly data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const id = (item as { readonly id?: unknown }).id;
      return typeof id === 'string' && id.length > 0 ? id : null;
    })
    .filter((id): id is string => id !== null)
    .sort((a, b) => a.localeCompare(b));
};

const codexVision = (id: string): boolean => {
  const m = id.toLowerCase();
  return /gpt-4o|o1|o3/.test(m);
};

const openAiApiFallbackCatalog = (): readonly ModelInfo[] => [
  { id: 'gpt-5', label: 'gpt-5', provider: 'openai-codex', promptCache: 'unknown', thinking: thinkingLevelsFor('gpt-5', []), supportsVision: codexVision('gpt-5') },
  { id: 'gpt-5-mini', label: 'gpt-5-mini', provider: 'openai-codex', promptCache: 'unknown', thinking: thinkingLevelsFor('gpt-5-mini', []), supportsVision: codexVision('gpt-5-mini') },
  { id: 'gpt-4.1', label: 'gpt-4.1', provider: 'openai-codex', promptCache: 'unknown', thinking: thinkingLevelsFor('gpt-4.1', []), supportsVision: codexVision('gpt-4.1') },
  { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini', provider: 'openai-codex', promptCache: 'unknown', thinking: thinkingLevelsFor('gpt-4.1-mini', []), supportsVision: codexVision('gpt-4.1-mini') },
  { id: 'o4-mini', label: 'o4-mini', provider: 'openai-codex', promptCache: 'unknown', thinking: thinkingLevelsFor('o4-mini', []), supportsVision: codexVision('o4-mini') },
];

export const allowedThinkingForSelection = (
  modelId: string,
  provider: ModelProviderKind,
  catalog: readonly ModelInfo[],
): readonly ThinkingLevel[] => {
  const exact = catalog.find((model) => model.id === modelId && model.provider === provider);
  return exact?.thinking ?? thinkingLevelsFor(modelId, catalog);
};

const localPresetRows = (pulledIds: readonly string[]): readonly ModelInfo[] => {
  return pulledIds.map((id) => ({
    id,
    label: id,
    provider: 'local',
    promptCache: 'unsupported',
    thinking: inferLocalThinking(id),
    supportsVision: false,
  }));
};

const inferLocalThinking = (id: string): readonly ThinkingLevel[] => {
  const normalized = id.toLowerCase();
  if (/deepseek-r1|qwen3.*think/.test(normalized)) return ['off', 'low', 'medium'];
  return ['off'];
};

const inferModelProvider = (
  modelId: string,
  configuredProvider: ModelProviderKind,
  catalog: readonly ModelInfo[],
): ModelProviderKind => {
  const exact = catalog.find((model) => model.id === modelId);
  if (exact) return exact.provider;
  if (modelId.startsWith('opencode-go/')) return 'opencode-go';
  if (modelId.startsWith('opencode/')) return 'opencode-zen';
  if (modelId.includes('/') && configuredProvider === 'openrouter') return 'openrouter';
  if (modelId.startsWith('claude-')) return 'anthropic';
  if (/^(gpt-|codex-|o[1-9])/.test(modelId.toLowerCase())) return 'openai-codex';
  if (modelId.includes(':')) return 'local';
  return configuredProvider;
};

const cacheLabel = (support: PromptCacheSupport): string => {
  switch (support) {
    case 'supported':
      return 'cache: yes (cheaper)';
    case 'unsupported':
      return 'cache: no';
    case 'unknown':
      return 'cache: unknown';
  }
};

const compareModelSummaries = (a: VsCodeModelSummary, b: VsCodeModelSummary): number => {
  if (a.active !== b.active) return a.active ? -1 : 1;
  if (a.configuredDefault !== b.configuredDefault) return a.configuredDefault ? -1 : 1;
  if (a.provider !== b.provider) return providerRank(a.provider) - providerRank(b.provider);
  return a.id.localeCompare(b.id);
};

const providerRank = (provider: ModelProviderKind): number => {
  switch (provider) {
    case 'local':
      return 0;
    case 'anthropic':
      return 1;
    case 'openai-codex':
      return 2;
    case 'opencode-go':
      return 3;
    case 'opencode-zen':
      return 4;
    case 'openrouter':
      return 5;
  }
};

const modelKey = (provider: ModelProviderKind, id: string): string => `${provider}:${id}`;
