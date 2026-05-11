import * as vscode from 'vscode';
import { atlasError, type AtlasError } from '@atlas/core/errors';
import { err, ok, type Result } from '@atlas/core/result';
import {
  DEFAULT_CONFIG_PATH,
  loadConfig,
  saveConfig,
  type AtlasConfig,
  type AtlasPowerMode,
  type LocalProviderToolMode,
} from '@atlas/core/config';

export type PromptSecretKey =
  | 'openrouter.apiKey'
  | 'anthropic.apiKey'
  | 'openai.apiKey'
  | 'opencode.zen.apiKey'
  | 'opencode.go.apiKey'
  | 'local.apiKey'
  | 'github.token';

export type VscodePowerMode = 'lite' | 'hybrid' | 'full';

export interface SafeConfigUpdate {
  readonly defaultProvider?: AtlasConfig['defaultProvider'];
  readonly defaultModel?: string;
  readonly routerModel?: string | null;
  readonly atlasMode?: AtlasPowerMode;
  readonly vscodePowerMode?: VscodePowerMode;
  readonly localBaseUrl?: string;
  readonly localAutoDetect?: boolean;
  readonly localToolMode?: LocalProviderToolMode;
  readonly localRequestTimeoutMs?: number;
  readonly anthropicUseClaudeCodeOauth?: boolean;
  readonly openaiAuthMode?: AtlasConfig['providers']['openai']['authMode'];
  readonly compactionEnabled?: boolean;
  readonly compactionModel?: string | null;
  readonly compactionThreshold?: number;
  readonly compactionContextTokens?: number;
  readonly shipAutoResolve?: AtlasConfig['ship']['autoResolve'];
  readonly promptOnConflict?: boolean;
  readonly guardrailsEnabled?: boolean;
  readonly guardrailDangerousCommand?: boolean;
  readonly guardrailPathSafety?: boolean;
  readonly guardrailSecretRedaction?: boolean;
  readonly guardrailPromptInjectionDetector?: boolean;
  readonly guardrailDiscoverGuardrails?: boolean;
  readonly guardrailProgressTracker?: boolean;
}

const SECRET_KEYS = {
  openrouterApiKey: 'atlas.providers.openrouter.apiKey',
  openrouterApiKeys: 'atlas.providers.openrouter.apiKeys',
  anthropicApiKey: 'atlas.providers.anthropic.apiKey',
  anthropicApiKeys: 'atlas.providers.anthropic.apiKeys',
  openAiApiKey: 'atlas.providers.openai.apiKey',
  openCodeZenApiKey: 'atlas.providers.opencode.zen.apiKey',
  openCodeGoApiKey: 'atlas.providers.opencode.go.apiKey',
  localApiKey: 'atlas.providers.local.apiKey',
  githubToken: 'atlas.github.token',
  codexAccessToken: 'atlas.providers.openai.codex.accessToken',
  codexRefreshToken: 'atlas.providers.openai.codex.refreshToken',
  codexIdToken: 'atlas.providers.openai.codex.idToken',
} as const;

const PROMPT_SECRET_META: Readonly<Record<PromptSecretKey, { readonly storageKey: string; readonly label: string }>> = {
  'openrouter.apiKey': { storageKey: SECRET_KEYS.openrouterApiKey, label: 'OpenRouter API key' },
  'anthropic.apiKey': { storageKey: SECRET_KEYS.anthropicApiKey, label: 'Anthropic API key' },
  'openai.apiKey': { storageKey: SECRET_KEYS.openAiApiKey, label: 'OpenAI API key' },
  'opencode.zen.apiKey': { storageKey: SECRET_KEYS.openCodeZenApiKey, label: 'OpenCode Zen API key' },
  'opencode.go.apiKey': { storageKey: SECRET_KEYS.openCodeGoApiKey, label: 'OpenCode Go API key' },
  'local.apiKey': { storageKey: SECRET_KEYS.localApiKey, label: 'Local provider API key' },
  'github.token': { storageKey: SECRET_KEYS.githubToken, label: 'GitHub token' },
};

export const promptSecretLabel = (key: PromptSecretKey): string => PROMPT_SECRET_META[key].label;

export const atlasConfigPath = (): string =>
  process.env['ATLAS_CONFIG'] ?? DEFAULT_CONFIG_PATH;

const VSCODE_POWER_MODE_KEY = 'vscodePowerMode';

export const getVscodePowerMode = (): VscodePowerMode | undefined => {
  const settings = vscode.workspace.getConfiguration('atlas');
  const value = settings.get<string>(VSCODE_POWER_MODE_KEY);
  if (value === 'lite' || value === 'hybrid' || value === 'full') return value;
  return undefined;
};

export const setVscodePowerMode = async (value: VscodePowerMode | undefined): Promise<void> => {
  const settings = vscode.workspace.getConfiguration('atlas');
  if (value === undefined) {
    await settings.update(VSCODE_POWER_MODE_KEY, undefined, true);
  } else {
    await settings.update(VSCODE_POWER_MODE_KEY, value, true);
  }
};

export const loadVsCodeConfig = async (
  context: vscode.ExtensionContext,
): Promise<Result<AtlasConfig, AtlasError>> => {
  const loaded = await loadConfig();
  if (!loaded.ok) return loaded;
  return ok(applyVsCodeSettings(await applyStoredSecrets(context, loaded.value)));
};

export const saveVsCodeConfig = async (
  context: vscode.ExtensionContext,
  config: AtlasConfig,
): Promise<Result<{ readonly path: string }, AtlasError>> => {
  await storeSecretsFromConfig(context, config);
  return saveConfig(stripStoredSecrets(config), { path: atlasConfigPath() });
};

export const updateVsCodeConfig = async (
  context: vscode.ExtensionContext,
  update: SafeConfigUpdate,
): Promise<Result<{ readonly path: string }, AtlasError>> => {
  if (update.vscodePowerMode !== undefined) {
    await setVscodePowerMode(update.vscodePowerMode);
  }
  const loaded = await loadVsCodeConfig(context);
  if (!loaded.ok) return err(loaded.error);
  const current = update.routerModel === null
    ? omitKeys(loaded.value, ['routerModel'] as const)
    : loaded.value;
  const currentCompaction = update.compactionModel === null
    ? omitKeys(current.compaction, ['model'] as const)
    : current.compaction;
  const next: AtlasConfig = {
    ...current,
    ...(update.defaultProvider !== undefined ? { defaultProvider: update.defaultProvider } : {}),
    ...(update.defaultModel !== undefined ? { defaultModel: update.defaultModel } : {}),
    ...(update.routerModel !== undefined && update.routerModel !== null ? { routerModel: update.routerModel } : {}),
    ...(update.atlasMode !== undefined ? { atlasMode: update.atlasMode } : {}),
    providers: {
      ...current.providers,
      anthropic: {
        ...current.providers.anthropic,
        ...(update.anthropicUseClaudeCodeOauth !== undefined ? { useClaudeCodeOauth: update.anthropicUseClaudeCodeOauth } : {}),
      },
      openai: {
        ...current.providers.openai,
        ...(update.openaiAuthMode !== undefined ? { authMode: update.openaiAuthMode } : {}),
      },
      local: {
        ...current.providers.local,
        ...(update.localBaseUrl !== undefined ? { baseUrl: update.localBaseUrl } : {}),
        ...(update.localAutoDetect !== undefined ? { autoDetect: update.localAutoDetect } : {}),
        ...(update.localToolMode !== undefined ? { toolMode: update.localToolMode, liteMode: update.localToolMode === 'lite' } : {}),
        ...(update.localRequestTimeoutMs !== undefined ? { requestTimeoutMs: update.localRequestTimeoutMs } : {}),
      },
    },
    compaction: {
      ...currentCompaction,
      ...(update.compactionEnabled !== undefined ? { enabled: update.compactionEnabled } : {}),
      ...(update.compactionModel !== undefined && update.compactionModel !== null ? { model: update.compactionModel } : {}),
      ...(update.compactionThreshold !== undefined ? { threshold: update.compactionThreshold } : {}),
      ...(update.compactionContextTokens !== undefined ? { contextTokens: update.compactionContextTokens } : {}),
    },
    ship: {
      ...current.ship,
      ...(update.shipAutoResolve !== undefined ? { autoResolve: update.shipAutoResolve } : {}),
      ...(update.promptOnConflict !== undefined ? { promptOnConflict: update.promptOnConflict } : {}),
    },
    guardrails: {
      ...current.guardrails,
      ...(update.guardrailsEnabled !== undefined ? { enabled: update.guardrailsEnabled } : {}),
      ...(update.guardrailDangerousCommand !== undefined ? { dangerousCommand: update.guardrailDangerousCommand } : {}),
      ...(update.guardrailPathSafety !== undefined ? { pathSafety: update.guardrailPathSafety } : {}),
      ...(update.guardrailSecretRedaction !== undefined ? { secretRedaction: update.guardrailSecretRedaction } : {}),
      ...(update.guardrailPromptInjectionDetector !== undefined ? { promptInjectionDetector: update.guardrailPromptInjectionDetector } : {}),
      ...(update.guardrailDiscoverGuardrails !== undefined ? { discoverGuardrails: update.guardrailDiscoverGuardrails } : {}),
      ...(update.guardrailProgressTracker !== undefined ? { progressTracker: update.guardrailProgressTracker } : {}),
    },
  };
  return saveVsCodeConfig(context, next);
};

export const promptAndStoreSecret = async (
  context: vscode.ExtensionContext,
  key: PromptSecretKey,
): Promise<Result<{ readonly key: PromptSecretKey; readonly configured: boolean }, AtlasError>> => {
  const meta = PROMPT_SECRET_META[key];
  const value = await vscode.window.showInputBox({
    title: `Atlas: ${meta.label}`,
    prompt: 'Stored in VS Code SecretStorage. It will not be written to Settings JSON or sent to the webview.',
    password: true,
    ignoreFocusOut: true,
  });
  const trimmed = value?.trim();
  if (!trimmed) {
    return err(atlasError('CONFIG_INVALID', `${meta.label} was not changed.`));
  }
  await context.secrets.store(meta.storageKey, trimmed);
  return ok({ key, configured: true });
};

export const storeSecretValue = async (
  context: vscode.ExtensionContext,
  key: PromptSecretKey,
  value: string,
): Promise<Result<{ readonly key: PromptSecretKey; readonly configured: boolean }, AtlasError>> => {
  const meta = PROMPT_SECRET_META[key];
  const trimmed = value.trim();
  if (!trimmed) {
    return err(atlasError('CONFIG_INVALID', `${meta.label} was not changed.`));
  }
  await context.secrets.store(meta.storageKey, trimmed);
  return ok({ key, configured: true });
};

export const clearStoredSecret = async (
  context: vscode.ExtensionContext,
  key: PromptSecretKey,
): Promise<Result<{ readonly key: PromptSecretKey; readonly configured: boolean }, AtlasError>> => {
  await context.secrets.delete(PROMPT_SECRET_META[key].storageKey);
  const loaded = await loadVsCodeConfig(context);
  if (!loaded.ok) return err(loaded.error);
  const saved = await saveVsCodeConfig(context, removeSecretFromConfig(loaded.value, key));
  if (!saved.ok) return err(saved.error);
  return ok({ key, configured: false });
};

export const storeCodexTokens = async (
  context: vscode.ExtensionContext,
  tokens: AtlasConfig['providers']['openai']['codex'],
): Promise<void> => {
  if (tokens.accessToken) await context.secrets.store(SECRET_KEYS.codexAccessToken, tokens.accessToken);
  if (tokens.refreshToken) await context.secrets.store(SECRET_KEYS.codexRefreshToken, tokens.refreshToken);
  if (tokens.idToken) await context.secrets.store(SECRET_KEYS.codexIdToken, tokens.idToken);
};

const applyStoredSecrets = async (
  context: vscode.ExtensionContext,
  config: AtlasConfig,
): Promise<AtlasConfig> => {
  const openrouterApiKey = await context.secrets.get(SECRET_KEYS.openrouterApiKey);
  const openrouterApiKeys = parseSecretArray(await context.secrets.get(SECRET_KEYS.openrouterApiKeys));
  const anthropicApiKey = await context.secrets.get(SECRET_KEYS.anthropicApiKey);
  const anthropicApiKeys = parseSecretArray(await context.secrets.get(SECRET_KEYS.anthropicApiKeys));
  const openAiApiKey = await context.secrets.get(SECRET_KEYS.openAiApiKey);
  const openCodeZenApiKey = await context.secrets.get(SECRET_KEYS.openCodeZenApiKey);
  const openCodeGoApiKey = await context.secrets.get(SECRET_KEYS.openCodeGoApiKey);
  const localApiKey = await context.secrets.get(SECRET_KEYS.localApiKey);
  const githubToken = await context.secrets.get(SECRET_KEYS.githubToken);
  const codexAccessToken = await context.secrets.get(SECRET_KEYS.codexAccessToken);
  const codexRefreshToken = await context.secrets.get(SECRET_KEYS.codexRefreshToken);
  const codexIdToken = await context.secrets.get(SECRET_KEYS.codexIdToken);

  return {
    ...config,
    providers: {
      ...config.providers,
      openrouter: {
        ...config.providers.openrouter,
        ...(openrouterApiKey ? { apiKey: openrouterApiKey } : {}),
        ...(openrouterApiKeys ? { apiKeys: openrouterApiKeys } : {}),
      },
      anthropic: {
        ...config.providers.anthropic,
        ...(anthropicApiKey ? { apiKey: anthropicApiKey } : {}),
        ...(anthropicApiKeys ? { apiKeys: anthropicApiKeys } : {}),
      },
      openai: {
        ...config.providers.openai,
        ...(openAiApiKey ? { apiKey: openAiApiKey } : {}),
        codex: {
          ...config.providers.openai.codex,
          ...(codexAccessToken ? { accessToken: codexAccessToken } : {}),
          ...(codexRefreshToken ? { refreshToken: codexRefreshToken } : {}),
          ...(codexIdToken ? { idToken: codexIdToken } : {}),
        },
      },
      opencode: {
        ...config.providers.opencode,
        zen: {
          ...config.providers.opencode.zen,
          ...(openCodeZenApiKey ? { apiKey: openCodeZenApiKey } : {}),
        },
        go: {
          ...config.providers.opencode.go,
          ...(openCodeGoApiKey ? { apiKey: openCodeGoApiKey } : {}),
        },
      },
      local: {
        ...config.providers.local,
        ...(localApiKey ? { apiKey: localApiKey } : {}),
      },
    },
    github: {
      ...config.github,
      ...(githubToken ? { token: githubToken } : {}),
    },
  };
};

const applyVsCodeSettings = (config: AtlasConfig): AtlasConfig => {
  const settings = vscode.workspace.getConfiguration('atlas');
  const defaultProvider = configuredSetting<AtlasConfig['defaultProvider']>(settings, 'defaultProvider');
  const defaultModel = configuredSetting<string>(settings, 'defaultModel');
  const routerModel = configuredSetting<string>(settings, 'routerModel');
  const atlasMode = configuredSetting<AtlasPowerMode>(settings, 'mode');
  const localBaseUrl = configuredSetting<string>(settings, 'local.baseUrl');
  const localAutoDetect = configuredSetting<boolean>(settings, 'local.autoDetect');
  const localToolMode = configuredSetting<LocalProviderToolMode>(settings, 'local.toolMode');
  const localRequestTimeoutMs = configuredSetting<number>(settings, 'local.requestTimeoutMs');
  const openrouterBaseUrl = configuredSetting<string>(settings, 'openrouter.baseUrl');
  const anthropicBaseUrl = configuredSetting<string>(settings, 'anthropic.baseUrl');
  const anthropicUseClaudeCodeOauth = configuredSetting<boolean>(settings, 'anthropic.useClaudeCodeOauth');
  const openaiAuthMode = configuredSetting<AtlasConfig['providers']['openai']['authMode']>(settings, 'openai.authMode');
  const openaiApiBaseUrl = configuredSetting<string>(settings, 'openai.apiBaseUrl');
  const compactionEnabled = configuredSetting<boolean>(settings, 'compaction.enabled');
  const compactionModel = configuredSetting<string>(settings, 'compaction.model');
  const compactionThreshold = configuredSetting<number>(settings, 'compaction.threshold');
  const compactionContextTokens = configuredSetting<number>(settings, 'compaction.contextTokens');
  const shipAutoResolve = configuredSetting<AtlasConfig['ship']['autoResolve']>(settings, 'ship.autoResolve');
  const promptOnConflict = configuredSetting<boolean>(settings, 'ship.promptOnConflict');
  const guardrailsEnabled = configuredSetting<boolean>(settings, 'guardrails.enabled');
  const guardrailDangerousCommand = configuredSetting<boolean>(settings, 'guardrails.dangerousCommand');
  const guardrailPathSafety = configuredSetting<boolean>(settings, 'guardrails.pathSafety');
  const guardrailSecretRedaction = configuredSetting<boolean>(settings, 'guardrails.secretRedaction');
  const guardrailPromptInjectionDetector = configuredSetting<boolean>(settings, 'guardrails.promptInjectionDetector');
  const guardrailDiscoverGuardrails = configuredSetting<boolean>(settings, 'guardrails.discoverGuardrails');
  const guardrailProgressTracker = configuredSetting<boolean>(settings, 'guardrails.progressTracker');

  return {
    ...config,
    ...(defaultProvider ? { defaultProvider } : {}),
    ...(defaultModel && defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
    ...(routerModel && routerModel.trim() ? { routerModel: routerModel.trim() } : {}),
    ...(atlasMode ? { atlasMode } : {}),
    providers: {
      ...config.providers,
      openrouter: {
        ...config.providers.openrouter,
        ...(openrouterBaseUrl && openrouterBaseUrl.trim() ? { baseUrl: openrouterBaseUrl.trim() } : {}),
      },
      anthropic: {
        ...config.providers.anthropic,
        ...(anthropicBaseUrl && anthropicBaseUrl.trim() ? { baseUrl: anthropicBaseUrl.trim() } : {}),
        ...(anthropicUseClaudeCodeOauth !== undefined ? { useClaudeCodeOauth: anthropicUseClaudeCodeOauth } : {}),
      },
      openai: {
        ...config.providers.openai,
        ...(openaiAuthMode ? { authMode: openaiAuthMode } : {}),
        ...(openaiApiBaseUrl && openaiApiBaseUrl.trim() ? { apiBaseUrl: openaiApiBaseUrl.trim() } : {}),
      },
      local: {
        ...config.providers.local,
        ...(localBaseUrl && localBaseUrl.trim() ? { baseUrl: localBaseUrl.trim() } : {}),
        ...(localAutoDetect !== undefined ? { autoDetect: localAutoDetect } : {}),
        ...(localToolMode ? { toolMode: localToolMode, liteMode: localToolMode === 'lite' } : {}),
        ...(localRequestTimeoutMs !== undefined ? { requestTimeoutMs: localRequestTimeoutMs } : {}),
      },
    },
    compaction: {
      ...config.compaction,
      ...(compactionEnabled !== undefined ? { enabled: compactionEnabled } : {}),
      ...(compactionModel && compactionModel.trim() ? { model: compactionModel.trim() } : {}),
      ...(compactionThreshold !== undefined ? { threshold: compactionThreshold } : {}),
      ...(compactionContextTokens !== undefined ? { contextTokens: compactionContextTokens } : {}),
    },
    ship: {
      ...config.ship,
      ...(shipAutoResolve ? { autoResolve: shipAutoResolve } : {}),
      ...(promptOnConflict !== undefined ? { promptOnConflict } : {}),
    },
    guardrails: {
      ...config.guardrails,
      ...(guardrailsEnabled !== undefined ? { enabled: guardrailsEnabled } : {}),
      ...(guardrailDangerousCommand !== undefined ? { dangerousCommand: guardrailDangerousCommand } : {}),
      ...(guardrailPathSafety !== undefined ? { pathSafety: guardrailPathSafety } : {}),
      ...(guardrailSecretRedaction !== undefined ? { secretRedaction: guardrailSecretRedaction } : {}),
      ...(guardrailPromptInjectionDetector !== undefined ? { promptInjectionDetector: guardrailPromptInjectionDetector } : {}),
      ...(guardrailDiscoverGuardrails !== undefined ? { discoverGuardrails: guardrailDiscoverGuardrails } : {}),
      ...(guardrailProgressTracker !== undefined ? { progressTracker: guardrailProgressTracker } : {}),
    },
  };
};

const configuredSetting = <T>(
  settings: vscode.WorkspaceConfiguration,
  key: string,
): T | undefined => {
  const inspected = settings.inspect<T>(key);
  return inspected?.workspaceFolderValue
    ?? inspected?.workspaceValue
    ?? inspected?.globalValue
    ?? undefined;
};

const storeSecretsFromConfig = async (
  context: vscode.ExtensionContext,
  config: AtlasConfig,
): Promise<void> => {
  const entries: readonly [string, string | undefined][] = [
    [SECRET_KEYS.openrouterApiKey, config.providers.openrouter.apiKey],
    [SECRET_KEYS.openrouterApiKeys, config.providers.openrouter.apiKeys.length > 0 ? JSON.stringify(config.providers.openrouter.apiKeys) : undefined],
    [SECRET_KEYS.anthropicApiKey, config.providers.anthropic.apiKey],
    [SECRET_KEYS.anthropicApiKeys, config.providers.anthropic.apiKeys.length > 0 ? JSON.stringify(config.providers.anthropic.apiKeys) : undefined],
    [SECRET_KEYS.openAiApiKey, config.providers.openai.apiKey],
    [SECRET_KEYS.openCodeZenApiKey, config.providers.opencode.zen.apiKey],
    [SECRET_KEYS.openCodeGoApiKey, config.providers.opencode.go.apiKey],
    [SECRET_KEYS.localApiKey, config.providers.local.apiKey],
    [SECRET_KEYS.githubToken, config.github.token],
    [SECRET_KEYS.codexAccessToken, config.providers.openai.codex.accessToken],
    [SECRET_KEYS.codexRefreshToken, config.providers.openai.codex.refreshToken],
    [SECRET_KEYS.codexIdToken, config.providers.openai.codex.idToken],
  ];
  for (const [key, value] of entries) {
    if (value) await context.secrets.store(key, value);
  }
};

const stripStoredSecrets = (config: AtlasConfig): AtlasConfig => {
  const openrouter = omitKeys(config.providers.openrouter, ['apiKey'] as const);
  const anthropic = omitKeys(config.providers.anthropic, ['apiKey'] as const);
  const openai = omitKeys(config.providers.openai, ['apiKey'] as const);
  const codex = omitKeys(config.providers.openai.codex, ['accessToken', 'refreshToken', 'idToken'] as const);
  const zen = omitKeys(config.providers.opencode.zen, ['apiKey'] as const);
  const go = omitKeys(config.providers.opencode.go, ['apiKey'] as const);
  const local = omitKeys(config.providers.local, ['apiKey'] as const);
  const github = omitKeys(config.github, ['token'] as const);
  return {
    ...config,
    providers: {
      ...config.providers,
      openrouter: { ...openrouter, apiKeys: [] },
      anthropic: { ...anthropic, apiKeys: [] },
      openai: {
        ...openai,
        codex,
      },
      opencode: {
        ...config.providers.opencode,
        zen,
        go,
      },
      local,
    },
    github,
  };
};

const removeSecretFromConfig = (config: AtlasConfig, key: PromptSecretKey): AtlasConfig => {
  switch (key) {
    case 'openrouter.apiKey':
      return {
        ...config,
        providers: {
          ...config.providers,
          openrouter: omitKeys(config.providers.openrouter, ['apiKey'] as const),
        },
      };
    case 'anthropic.apiKey':
      return {
        ...config,
        providers: {
          ...config.providers,
          anthropic: omitKeys(config.providers.anthropic, ['apiKey'] as const),
        },
      };
    case 'openai.apiKey':
      return {
        ...config,
        providers: {
          ...config.providers,
          openai: omitKeys(config.providers.openai, ['apiKey'] as const),
        },
      };
    case 'opencode.zen.apiKey':
      return {
        ...config,
        providers: {
          ...config.providers,
          opencode: {
            ...config.providers.opencode,
            zen: omitKeys(config.providers.opencode.zen, ['apiKey'] as const),
          },
        },
      };
    case 'opencode.go.apiKey':
      return {
        ...config,
        providers: {
          ...config.providers,
          opencode: {
            ...config.providers.opencode,
            go: omitKeys(config.providers.opencode.go, ['apiKey'] as const),
          },
        },
      };
    case 'local.apiKey':
      return {
        ...config,
        providers: {
          ...config.providers,
          local: omitKeys(config.providers.local, ['apiKey'] as const),
        },
      };
    case 'github.token':
      return {
        ...config,
        github: omitKeys(config.github, ['token'] as const),
      };
  }
};

const omitKeys = <T extends object, K extends keyof T>(
  value: T,
  keys: readonly K[],
): Omit<T, K> => {
  const output: Partial<T> = { ...value };
  for (const key of keys) delete output[key];
  return output as Omit<T, K>;
};

const parseSecretArray = (value: string | undefined): string[] | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string' && item.length > 0)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
};
