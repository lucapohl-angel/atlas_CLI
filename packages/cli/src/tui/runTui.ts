/**
 * TUI entrypoint — bootstraps providers/registries and mounts OpenTUI.
 *
 * If the user has not configured an API key yet, we still launch the TUI
 * in "setup" mode (provider = null). The App renders a setup overlay
 * that lets the user paste a key inside the program — no `vim` round-trip
 * required.
 */
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../commands/init.js';
import {
  AgentRegistry,
  SkillRegistry,
  allowAllPolicy,
  builtinHookRegistry,
  builtinToolRegistry,
  createAnthropicProvider,
  createCodexProvider,
  createDelegateRunner,
  createLocalProvider,
  createOpenCodeProvider,
  createOpenRouterProvider,
  DEFAULT_BUILTIN_MCP_SERVERS,
  fetchAnthropicModels,
  fetchCodexModels,
  fetchOpenCodeGoModels,
  fetchOpenCodeZenModels,
  fetchOpenRouterModels,
  listLocalModels,
  probeLocalProvider,
  loadAgents,
  loadConfig,
  loadSkills,
  loadActiveTask,
  loadClaudeCodeCredentials,
  loadToolsState,
  providerFromConfigAsync,
  registerMcpTools,
  saveConfig,
  SessionStore,
  startMcpServers,
  TodoStore,
  type AtlasConfig,
  type McpStartupResult,
  type ModelInfo,
  type Provider,
  type SessionRecord
} from '@atlas/core';
import { printAtlasExitSplash, restoreInteractiveTerminal } from './exit-splash.js';
import { checkForAtlasUpdate, dismissAtlasUpdateNotice } from './update-notice.js';

export interface RunTuiOptions {
  readonly model?: string;
  readonly agent?: string;
  /** Inject a provider (tests). */
  readonly provider?: Provider;
  /** Inject config (tests). */
  readonly config?: AtlasConfig;
  /** Resume an existing session by id, or 'latest' for the most recent. */
  readonly resume?: string;
}

export interface RunTuiResult {
  readonly exitCode: number;
}

const OPENROUTER_FALLBACK_MODELS = [
  'anthropic/claude-opus-4.7',
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-opus-4.5',
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4',
  'anthropic/claude-opus-4',
  'openai/gpt-5.5',
  'openai/gpt-5',
  'openai/gpt-5-mini',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'deepseek/deepseek-v4',
  'moonshotai/kimi-2.6',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash'
];

const ANTHROPIC_NATIVE_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-5',
  'claude-opus-4-5',
  'claude-haiku-4-5',
  'claude-opus-4',
  'claude-sonnet-4',
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest'
];

type RuntimeProviderKind = ModelInfo['provider'];
type RuntimeProviders = Partial<Record<RuntimeProviderKind, Provider>>;

const RUNTIME_PROVIDER_FALLBACK_ORDER: readonly RuntimeProviderKind[] = [
  'local',
  'anthropic',
  'openai-codex',
  'opencode-go',
  'opencode-zen',
  'openrouter'
];

// Recommended local models surfaced in the picker when Ollama is running
// but the user hasn't configured a preferred model. Ordered by quality
// within the constraint of being runnable on modest hardware.
const LOCAL_RECOMMENDED_MODELS: readonly ModelInfo[] = [
  { id: 'qwen2.5-coder:7b',  label: 'Qwen 2.5 Coder 7B (recommended)',  thinking: ['off'], provider: 'local', promptCache: 'unsupported', supportsVision: false },
  { id: 'qwen2.5-coder:3b',  label: 'Qwen 2.5 Coder 3B',                thinking: ['off'], provider: 'local', promptCache: 'unsupported', supportsVision: false },
  { id: 'qwen2.5-coder:1.5b',label: 'Qwen 2.5 Coder 1.5B (lightweight)',thinking: ['off'], provider: 'local', promptCache: 'unsupported', supportsVision: false },
  { id: 'llama3.1:8b',       label: 'Llama 3.1 8B',                     thinking: ['off'], provider: 'local', promptCache: 'unsupported', supportsVision: false },
  { id: 'deepseek-r1:7b',    label: 'DeepSeek R1 7B (reasoning)',        thinking: ['off', 'low', 'medium'], provider: 'local', promptCache: 'unsupported', supportsVision: false },
];

/**
 * Infer thinking-level support from a local model id.
 * DeepSeek-R1 and Qwen3-thinking variants emit <think>…</think> blocks
 * which the provider strips into thinking events.
 */
const inferLocalThinking = (id: string): readonly import('@atlas/core').ThinkingLevel[] => {
  const m = id.toLowerCase();
  if (/deepseek-r1|qwen3.*think/.test(m)) return ['off', 'low', 'medium'];
  return ['off'];
};

export interface StartupModelSelectionInput {
  readonly explicitModel?: string;
  readonly resumedModel?: string;
  readonly configuredModel: string;
  readonly modelCatalog?: readonly ModelInfo[];
  readonly providers: RuntimeProviders;
  readonly fallbackPool: readonly string[];
}

const trimmedOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

export const providerKindForStartupModel = (
  modelId: string,
  catalog: readonly ModelInfo[] | undefined
): RuntimeProviderKind | null => {
  const hit = catalog?.find((m) => m.id === modelId);
  if (hit) return hit.provider;
  if (modelId.startsWith('opencode-go/')) return 'opencode-go';
  if (modelId.startsWith('opencode/')) return 'opencode-zen';
  if (modelId.includes('/')) return 'openrouter';
  const m = modelId.toLowerCase();
  if (/^claude/.test(m)) return 'anthropic';
  if (/^(gpt-|codex-|o[1-9])/.test(m)) return 'openai-codex';
  // Model ids that look like Ollama tags (e.g. "qwen2.5-coder:7b",
  // "llama3.1:8b") have a colon separator — no provider prefix, no slash.
  if (/:/.test(modelId) && !modelId.includes('/')) return 'local';
  return null;
};

const hasRuntimeForModel = (
  modelId: string,
  catalog: readonly ModelInfo[] | undefined,
  providers: RuntimeProviders
): boolean => {
  const kind = providerKindForStartupModel(modelId, catalog);
  return kind === null || Boolean(providers[kind]);
};

const firstConnectedCatalogModel = (
  catalog: readonly ModelInfo[] | undefined,
  providers: RuntimeProviders
): string | undefined => {
  for (const providerKind of RUNTIME_PROVIDER_FALLBACK_ORDER) {
    if (!providers[providerKind]) continue;
    const hit = catalog?.find((m) => m.provider === providerKind);
    if (hit) return hit.id;
  }
  if (providers.local) return LOCAL_RECOMMENDED_MODELS[0]?.id;
  if (providers.anthropic) return ANTHROPIC_NATIVE_MODELS[0];
  if (providers['openai-codex']) return 'gpt-5';
  if (providers['opencode-go']) return 'opencode-go/kimi-k2.6';
  if (providers['opencode-zen']) return 'opencode/gpt-5.5';
  if (providers.openrouter) return OPENROUTER_FALLBACK_MODELS[0];
  return undefined;
};

export const chooseStartupModel = (input: StartupModelSelectionInput): string => {
  const explicit = trimmedOrUndefined(input.explicitModel);
  if (explicit) return explicit;

  const resumed = trimmedOrUndefined(input.resumedModel);
  if (resumed && hasRuntimeForModel(resumed, input.modelCatalog, input.providers)) {
    return resumed;
  }

  const configured = trimmedOrUndefined(input.configuredModel) ?? input.configuredModel;
  if (hasRuntimeForModel(configured, input.modelCatalog, input.providers)) {
    return configured;
  }

  return (
    firstConnectedCatalogModel(input.modelCatalog, input.providers) ??
    input.fallbackPool[0] ??
    configured
  );
};

export const providerForStartupModel = (
  modelId: string,
  catalog: readonly ModelInfo[] | undefined,
  providers: RuntimeProviders
): Provider | null => {
  const kind = providerKindForStartupModel(modelId, catalog);
  return kind ? providers[kind] ?? null : null;
};

export const shouldLoadStartupSession = (
  resume: string | undefined
): resume is string =>
  resume !== undefined;

/**
 * If the user hasn't configured a key explicitly but has Claude Code
 * installed, switch to the Anthropic provider with native model ids and
 * use their OAuth credentials. Keeps explicit user config (apiKey on
 * either provider, or `defaultProvider` set in ~/.atlas/config.yaml)
 * untouched.
 */
/**
 * Auto-detect a running Ollama (or any OpenAI-compatible local server)
 * with a short probe. When found and no provider is explicitly configured,
 * switch `defaultProvider` to `local` and set a sensible default model
 * (the first pulled model found via /models, falling back to a
 * recommended preset). This runs before `maybeAutoDetectClaudeCode` so
 * paid-cloud credentials still win when present.
 */
const maybeAutoDetectLocal = async (cfg: AtlasConfig): Promise<AtlasConfig> => {
  // Only auto-switch when no cloud provider key is configured and the
  // user hasn't explicitly chosen a provider.
  const hasCloudKey =
    Boolean(cfg.providers.openrouter.apiKey) ||
    Boolean(cfg.providers.anthropic.apiKey) ||
    Boolean(cfg.providers.opencode.zen.apiKey) ||
    Boolean(cfg.providers.opencode.go.apiKey);
  if (hasCloudKey) return cfg;
  if (cfg.defaultProvider !== 'openrouter') return cfg;
  if (!cfg.providers.local.autoDetect) return cfg;

  const baseUrl = cfg.providers.local.baseUrl;
  const reachable = await probeLocalProvider(baseUrl);
  if (!reachable) return cfg;

  // Ollama is up — discover pulled models.
  const pulledIds = await listLocalModels(baseUrl,
    cfg.providers.local.apiKey ? { apiKey: cfg.providers.local.apiKey } : {}
  );

  // Pick a default model: first pulled model, else keep existing if it
  // looks local, else fall back to the top recommended preset.
  const looksLikeOpenRouterId = cfg.defaultModel.includes('/');
  const defaultModel =
    pulledIds?.[0] ??
    (looksLikeOpenRouterId ? LOCAL_RECOMMENDED_MODELS[0]!.id : cfg.defaultModel);

  return {
    ...cfg,
    defaultProvider: 'local',
    defaultModel
  };
};

const maybeAutoDetectClaudeCode = async (cfg: AtlasConfig): Promise<AtlasConfig> => {
  const orHasKey = Boolean(cfg.providers.openrouter.apiKey);
  const anHasKey = Boolean(cfg.providers.anthropic.apiKey);
  // If anything is already configured, respect it.
  if (orHasKey || anHasKey) return cfg;
  if (cfg.defaultProvider !== 'openrouter') return cfg; // user picked something explicitly

  const creds = await loadClaudeCodeCredentials({});
  if (!creds.ok) return cfg;

  // Promote to anthropic + a native model id. Only override defaultModel
  // if it still looks like the OpenRouter-shaped default (`provider/id`).
  const looksLikeOpenRouterId = cfg.defaultModel.includes('/');
  return {
    ...cfg,
    defaultProvider: 'anthropic',
    defaultModel: looksLikeOpenRouterId ? 'claude-sonnet-4-5' : cfg.defaultModel
  };
};

/**
 * On first launch, seed the user's config with the curated set of
 * built-in MCP servers (currently just `memory` so the agent has
 * persistent notes across sessions out-of-the-box). The
 * `mcp.builtinsSeeded` flag prevents us from re-adding entries the
 * user explicitly removes later.
 */
const maybeSeedDefaultMcps = async (cfg: AtlasConfig): Promise<AtlasConfig> => {
  if (cfg.mcp.builtinsSeeded) return cfg;
  const existing = new Set(cfg.mcp.servers.map((s) => s.name));
  const additions = DEFAULT_BUILTIN_MCP_SERVERS.filter((s) => !existing.has(s.name));
  const next: AtlasConfig = {
    ...cfg,
    mcp: {
      ...cfg.mcp,
      servers: [...cfg.mcp.servers, ...additions],
      builtinsSeeded: true
    }
  };
  // Persist so the flag survives restarts even if the user wipes the
  // server list. Failures are silent — we still return the in-memory
  // copy so the current run benefits from the seed.
  await saveConfig(next).catch(() => {});
  return next;
};

/**
 * On first launch (fresh install, no `~/.atlas/agents/atlas/AGENT.md`
 * yet), silently seed the built-in agents, skills, templates, and
 * checklists so the user can start chatting immediately without having
 * to remember `atlas init`. We swallow the SearXNG prompt and write
 * the verbose file list to /dev/null — only print a one-liner to
 * stderr so the user knows what happened.
 */
const maybeAutoInit = async (): Promise<void> => {
  const sentinel = join(homedir(), '.atlas', 'agents', 'atlas', 'AGENT.md');
  try {
    await stat(sentinel);
    return; // already initialized
  } catch {
    // fall through and init
  }
  try {
    // Discard the per-file write log; users only need to know it happened.
    const sink: NodeJS.WritableStream = {
      write: (() => true) as NodeJS.WritableStream['write']
    } as NodeJS.WritableStream;
    const r = await runInit({ stdout: sink, offerSearxng: false });
    process.stderr.write(
      `atlas: first-run setup — installed ${r.written.length} built-in files to ~/.atlas/\n`
    );
  } catch (err) {
    process.stderr.write(
      `atlas: first-run setup failed (${(err as Error).message}). Run \`atlas init\` manually.\n`
    );
  }
};

export const runTui = async (opts: RunTuiOptions = {}): Promise<RunTuiResult> => {
  // First-launch bootstrap: if ~/.atlas/ has no agents installed yet
  // (fresh `npm install -g atlas-os` with no prior `atlas init`), seed
  // the built-in agents/skills/templates silently so the TUI has
  // something to work with. Idempotent — skipped on subsequent runs.
  if (!opts.provider && !opts.config) {
    await maybeAutoInit();
  }

  let provider: Provider | null = null;
  let cfg: AtlasConfig | null = null;
  let setupError: string | null = null;

  if (opts.provider) {
    provider = opts.provider;
    cfg = opts.config ?? null;
  } else {
    const cfgResult = await loadConfig({ env: process.env });
    if (!cfgResult.ok) {
      setupError = cfgResult.error.message;
    } else {
      cfg = await maybeAutoDetectLocal(cfgResult.value);
      cfg = await maybeAutoDetectClaudeCode(cfg);
      cfg = await maybeSeedDefaultMcps(cfg);
      const provResult = await providerFromConfigAsync(cfg);
      if (provResult.ok) {
        provider = provResult.value;
      } else {
        setupError = provResult.error.message;
      }
    }
  }

  const agentsResult = await loadAgents();
  const skillsResult = await loadSkills();
  const agents = new AgentRegistry(agentsResult.ok ? agentsResult.value : []);
  const skills = new SkillRegistry(skillsResult.ok ? skillsResult.value : []);
  const tools = builtinToolRegistry();

  // Honor the user's `/tools` disable list at boot. We unregister
  // disabled tools so they're invisible to the loop (rather than
  // gating at invoke time, which would still surface them in the
  // tool list and confuse the model).
  const toolsState = await loadToolsState();
  for (const name of toolsState.disabled) tools.unregister(name);

  // Spawn every enabled MCP server in parallel and graft their tools
  // onto the registry so the agent loop can call them transparently.
  // Failures are non-fatal: a misconfigured server doesn't block boot,
  // it just won't appear in `/mcps`. Collected so the App can render
  // status and so we can stop the children on exit.
  const mcpStartup: McpStartupResult = await (async () => {
    const enabled = cfg?.mcp.servers.filter((s) => s.enabled) ?? [];
    if (enabled.length === 0) return { running: [], failed: [], stopAll: () => {} };
    const specs = enabled.map((s) => {
      if (s.transport === 'http') {
        // URL is required for http transport — schema allows .optional()
        // because of the discriminated shape, but at runtime an enabled
        // http server without a URL is a config error we surface as a
        // failed-server entry by routing through a synthetic spec that
        // will fail `start()` cleanly with a clear message.
        return {
          transport: 'http' as const,
          name: s.name,
          url: s.url ?? '',
          headers: s.headers
        };
      }
      return {
        transport: 'stdio' as const,
        name: s.name,
        command: s.command ?? '',
        args: s.args,
        env: { ...process.env, ...s.env }
      };
    });
    const result = await startMcpServers(specs);
    registerMcpTools(tools, result.running);
    return result;
  })();

  const fallbackPool =
    cfg?.defaultProvider === 'anthropic'
      ? ANTHROPIC_NATIVE_MODELS
      : cfg?.defaultProvider === 'local'
        ? LOCAL_RECOMMENDED_MODELS.map((m) => m.id)
        : OPENROUTER_FALLBACK_MODELS;
  const configuredModel =
    cfg?.defaultModel ??
    (cfg?.defaultProvider === 'anthropic' ? 'claude-sonnet-4-5' : 'anthropic/claude-sonnet-4');
  const fallbackModels = cfg?.fallbackModels ?? [];

  // Pull the live model catalog so the picker + thinking levels reflect
  // what the provider actually exposes today (cached for 24h on disk).
  // Failures are non-fatal — we just fall back to the hardcoded seed list.
  const modelCatalog = await loadModelCatalog(cfg);

  // Build every provider the user has credentials for, so /models can
  // route chat to the right backend on selection. The active `provider`
  // (from providerFromConfigAsync above) is just the startup default.
  const providers = await buildAllProviders(cfg);

  // Sessions: SessionStore writes JSON snapshots to ~/.atlas/sessions/.
  // Behavior:
  //   - --resume <id|latest>  -> explicit load (error surfaced if missing).
  //   - no flag -> always start fresh on the splash. Saved sessions are
  //     still available through `/sessions` or `/resume <id>` after launch.
  // We do NOT create a session record on boot anymore — the App lazily
  // creates one on the first user message so opening Atlas just to swap
  // with `/sessions` doesn't litter the store with empty entries.
  const sessionStore = new SessionStore();
  let initialSession: SessionRecord | null = null;
  let autoResumed = false;
  if (shouldLoadStartupSession(opts.resume)) {
    const loaded =
      opts.resume === 'latest'
        ? await sessionStore.latest()
        : await sessionStore.load(opts.resume);
    if (loaded.ok && loaded.value) {
      initialSession = loaded.value;
    } else {
      process.stderr.write(
        `atlas: could not resume session '${opts.resume}'${loaded.ok ? ' (no sessions saved yet)' : `: ${loaded.error.message}`}\n`
      );
    }
  }

  // Startup model priority:
  //   1. explicit --model
  //   2. model from an explicitly resumed session
  //   3. config defaultModel, when its provider is connected
  //   4. first model exposed by a connected provider
  const defaultModel = chooseStartupModel({
    configuredModel,
    providers,
    fallbackPool,
    ...(modelCatalog ? { modelCatalog } : {}),
    ...(opts.model ? { explicitModel: opts.model } : {}),
    ...(initialSession?.model ? { resumedModel: initialSession.model } : {})
  });
  const startupProvider = providerForStartupModel(defaultModel, modelCatalog, providers);
  if (startupProvider) {
    provider = startupProvider;
    setupError = null;
  }

  const availableModels = uniq([defaultModel, ...fallbackModels, ...fallbackPool]);

  // The orchestrator (`atlas`) is the default entry. If the user passed
  // -a we honor it; otherwise prefer `atlas`, falling back to the first
  // installed agent (preserves behavior on minimal installs).
  const initialAgent =
    opts.agent ??
    (agentsResult.ok && agentsResult.value.some((a) => a.name === 'atlas') ? 'atlas' : undefined);

  if (
    !opts.agent &&
    agentsResult.ok &&
    !agentsResult.value.some((a) => a.name === 'atlas') &&
    agentsResult.value.length > 0
  ) {
    process.stderr.write(
      "atlas: orchestrator agent not installed. Run `atlas init -f` to upgrade your ~/.atlas/ install.\n"
    );
  }

  // Workflow phase router — load the cwd's active task (if any) so the
  // TUI's status chip reflects the in-flight phase from the moment it
  // mounts. A missing or stale `.atlas/tasks/current.json` resolves to
  // null (idle) without surfacing an error — the workflow store is a
  // local convenience, not a hard dependency.
  const activeTask = await loadActiveTask(process.cwd());
  const initialActiveTask = activeTask.ok ? activeTask.value : null;

  const props = {
    provider,
    providers,
    agents,
    skills,
    tools,
    toolContext: ((): import('@atlas/core').ToolContext => {
      const cwd = process.cwd();
      const todoStore = new TodoStore();
      // Wire the delegate runner so the `delegate` tool can fan out to
      // child agents. Children inherit the same provider + tool stack;
      // the runner strips ask-approval tools and caps depth itself.
      const defaultAgent =
        agents.get(initialAgent ?? 'atlas') ?? agents.list()[0];
      const delegateRun =
        provider && defaultAgent
          ? createDelegateRunner({
              provider,
              model: defaultModel,
              fallbackModels,
              agents: new Map(agents.list().map((a) => [a.name, a])),
              defaultAgent,
              skills: skills.list(),
              baseTools: tools,
              baseToolContext: { cwd },
              currentDepth: 0
            })
          : undefined;
      // Wire the slice-3 plan executor: each plan task gets its own
      // child agent loop rooted at the freshly-created worktree path.
      // We construct a fresh per-task runner so the child's cwd is the
      // worktree, not the user's cwd. The runner itself bans recursion
      // (delegate is stripped from child registries, depth-capped).
      const executePlanRun: import('@atlas/core').RunTaskFn | undefined =
        provider && defaultAgent
          ? async (req) => {
              const childRunner = createDelegateRunner({
                provider,
                model: defaultModel,
                fallbackModels,
                agents: new Map(agents.list().map((a) => [a.name, a])),
                defaultAgent,
                skills: skills.list(),
                baseTools: tools,
                // Block plan_execute inside a child to prevent a child
                // task from re-entering the wave executor.
                blockedTools: ['plan_execute'],
                baseToolContext: { cwd: req.worktree.path },
                currentDepth: 0
              });
              const stopWhenLine =
                req.task.stopWhen && req.task.stopWhen.trim().length > 0
                  ? `\n\nStop / abort condition (treat as a hard budget — if you hit it, stop and report instead of pushing through):\n${req.task.stopWhen}`
                  : '';
              const goal =
                `Implement plan task ${req.task.id} (${req.task.name}).\n\n` +
                `Files to touch (relative to this cwd):\n` +
                req.task.files.map((f) => `  - ${f}`).join('\n') +
                `\n\nAction:\n${req.task.action}\n\n` +
                `Done criterion:\n${req.task.done}\n\n` +
                `Verify command (will be run automatically after you finish — do NOT run it yourself):\n${req.task.verify}` +
                stopWhenLine +
                `\n\nYou are working inside an isolated git worktree. Make only the changes ` +
                `this task requires. Do not commit — that happens automatically after verify passes.`;
              const out = await childRunner({
                goal,
                ...(req.signal ? { signal: req.signal } : {}),
                ...(req.approve ? { approve: req.approve } : {})
              });
              return {
                ok: out.ok,
                summary: out.summary,
                ...(out.error ? { error: out.error } : {})
              };
            }
          : undefined;
      return {
        cwd,
        approve: allowAllPolicy,
        todoStore,
        ...(delegateRun ? { delegateRun } : {}),
        ...(executePlanRun ? { executePlanRun } : {}),
        ...(cfg?.ship
          ? {
              shipDefaults: {
                autoResolve: cfg.ship.autoResolve,
                promptOnConflict: cfg.ship.promptOnConflict
              }
            }
          : {})
      };
    })(),
    hooks: builtinHookRegistry({
      cwd: process.cwd(),
      ...(cfg?.guardrails ? { config: cfg.guardrails } : {})
    }),
    defaultModel,
    fallbackModels,
    availableModels,
    modelCatalog,
    sessionStore,
    ...(initialSession ? { initialSession } : {}),
    autoResumed,
    initialActiveTask,
    mcpStatus: {
      running: mcpStartup.running.map((r) => ({
        name: r.spec.name,
        toolCount: r.tools.length
      })),
      failed: mcpStartup.failed.map((f) => ({
        name: f.spec.name,
        error: f.error.message
      }))
    },
    ...(initialAgent ? { initialAgentName: initialAgent } : {}),
    ...(cfg ? { config: cfg } : {}),
    ...(setupError ? { setupError } : {}),
    checkForUpdate: async () => {
      const result = await checkForAtlasUpdate();
      return result.ok ? result.value : null;
    },
    dismissUpdateNotice: async (latestVersion: string) => {
      await dismissAtlasUpdateNotice(latestVersion);
    }
  };

  const stopMcp = (): void => {
    mcpStartup.stopAll();
  };
  process.on('exit', stopMcp);

  let result: RunTuiResult | undefined;
  try {
    const { runOpenTui } = await import('./opentui/runOpenTui.js');
    result = await runOpenTui(props);
  } finally {
    process.off('exit', stopMcp);
    stopMcp();
  }
  restoreInteractiveTerminal();
  if (result?.exitCode === 0) printAtlasExitSplash();
  restoreInteractiveTerminal();
  return result ?? { exitCode: 1 };
};

const uniq = (arr: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
};

const loadModelCatalog = async (
  cfg: AtlasConfig | null
): Promise<readonly ModelInfo[] | undefined> => {
  if (!cfg) return undefined;

  // Load every catalog the user has credentials for, in parallel. The
  // active provider drives chat, but the picker shows the whole connected
  // surface so users can see (and toggle to) e.g. ChatGPT models after
  // signing in via /config → ChatGPT.
  const tasks: Promise<readonly ModelInfo[]>[] = [];

  // OpenRouter has a public /models endpoint — load it when an
  // OpenRouter key is configured. Force-refresh on startup so the user
  // gets the live list immediately (the endpoint is unauthenticated
  // and quick); fallback to cache if the network call fails.
  if (cfg.providers.openrouter.apiKey) {
    tasks.push(
      fetchOpenRouterModels({ forceRefresh: true }).then((r) => (r.ok ? r.value : []))
    );
  }

  // Anthropic — direct key first, otherwise Claude Code OAuth.
  const anKey = cfg.providers.anthropic.apiKey;
  if (anKey) {
    tasks.push(
      fetchAnthropicModels({ kind: 'apiKey', token: anKey }).then((r) =>
        r.ok ? r.value : []
      )
    );
  } else {
    tasks.push(
      (async () => {
        const creds = await loadClaudeCodeCredentials({});
        if (!creds.ok) return [];
        const r = await fetchAnthropicModels({
          kind: 'oauth',
          token: creds.value.accessToken
        });
        return r.ok ? r.value : [];
      })()
    );
  }

  // Codex / ChatGPT — return the curated catalog when the user has a
  // valid (non-expired) ChatGPT OAuth token. The backend has no public
  // /models endpoint, so we don't try to call one.
  const codexAuth = cfg.providers.openai?.codex;
  if (codexAuth?.accessToken) {
    const accessToken = codexAuth.accessToken;
    const opts: { accountId?: string; expiresAt?: number } = {};
    if (codexAuth.accountId) opts.accountId = codexAuth.accountId;
    if (typeof codexAuth.expiresAt === 'number') opts.expiresAt = codexAuth.expiresAt;
    tasks.push(fetchCodexModels(accessToken, opts).then((r) => (r.ok ? r.value : [])));
  }

  const openCodeZenKey = cfg.providers.opencode.zen.apiKey;
  if (openCodeZenKey) {
    tasks.push(
      fetchOpenCodeZenModels(openCodeZenKey, {
        forceRefresh: true,
        baseUrl: cfg.providers.opencode.zen.baseUrl
      }).then((r) => (r.ok ? r.value : []))
    );
  }

  const openCodeGoKey = cfg.providers.opencode.go.apiKey;
  if (openCodeGoKey) {
    tasks.push(
      fetchOpenCodeGoModels(openCodeGoKey, {
        forceRefresh: true,
        baseUrl: cfg.providers.opencode.go.baseUrl
      }).then((r) => (r.ok ? r.value : []))
    );
  }

  // Local / Ollama — probe the server and list whatever models the user
  // has pulled. We also splice in the recommended presets (uninstalled
  // ones show up dimmed in the picker so the user knows what to pull).
  // The probe uses a short timeout so it doesn't delay startup when no
  // local server is running.
  const lo = cfg.providers.local;
  if (lo.autoDetect || cfg.defaultProvider === 'local') {
    tasks.push(
      (async (): Promise<readonly ModelInfo[]> => {
        const reachable = await probeLocalProvider(lo.baseUrl);
        if (!reachable) {
          // Server not running — still expose recommended presets so the
          // user can see what to pull, marked as not pulled.
          return LOCAL_RECOMMENDED_MODELS.map((m) => ({
            ...m,
            label: `${m.id} — not pulled`
          }));
        }
        const pulledIds = await listLocalModels(lo.baseUrl,
          lo.apiKey ? { apiKey: lo.apiKey } : {}
        );
        if (!pulledIds || pulledIds.length === 0) {
          return LOCAL_RECOMMENDED_MODELS.map((m) => ({
            ...m,
            label: `${m.id} — not pulled`
          }));
        }
        // Build ModelInfo for each pulled model. Infer thinking support
        // from the model name family.
        const pulledSet = new Set(pulledIds);
        const pulled: ModelInfo[] = pulledIds.map((id) => ({
          id,
          label: id,
          thinking: inferLocalThinking(id),
          promptCache: 'unsupported',
          provider: 'local' as const,
          supportsVision: false,
        }));
        // Append recommended models that aren't already pulled. Mark
        // them so the picker can render them dimmer / with a hint to
        // pull first. We do this by suffixing the label — the picker
        // shows label, not id, for non-openrouter rows.
        const extras: ModelInfo[] = LOCAL_RECOMMENDED_MODELS
          .filter((m) => !pulledSet.has(m.id))
          .map((m) => ({ ...m, label: `${m.id} — not pulled` }));
        return [...pulled, ...extras];
      })()
    );
  }

  const results = await Promise.all(tasks);
  const merged: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const list of results) {
    for (const m of list) {
      // Same id can appear in multiple providers (e.g. `gpt-5` on both
      // OpenRouter and Codex). Key by `provider:id` so each surfaces.
      const key = `${m.provider}:${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(m);
    }
  }
  return merged.length > 0 ? merged : undefined;
};

/**
 * Build every provider the user has credentials for. The TUI keeps
 * this map and routes chat to the matching backend whenever the user
 * picks a model from a different provider in `/models`. The active
 * provider at startup is still selected by `providerFromConfigAsync`
 * so first-render behavior matches the user's `defaultProvider`.
 */
export const buildAllProviders = async (
  cfg: AtlasConfig | null
): Promise<RuntimeProviders> => {
  if (!cfg) return {};
  const out: RuntimeProviders = {};

  const or = cfg.providers.openrouter;
  if (or.apiKey) {
    out.openrouter = createOpenRouterProvider({
      apiKey: or.apiKey,
      ...(or.apiKeys.length > 0 ? { fallbackKeys: or.apiKeys } : {}),
      baseUrl: or.baseUrl,
      ...(or.referer !== undefined ? { referer: or.referer } : {}),
      title: or.title
    });
  }

  const an = cfg.providers.anthropic;
  if (an.apiKey) {
    out.anthropic = createAnthropicProvider({
      auth: {
        kind: 'apiKey',
        apiKey: an.apiKey,
        ...(an.apiKeys.length > 0 ? { fallbackKeys: an.apiKeys } : {})
      },
      baseUrl: an.baseUrl
    });
  } else if (an.useClaudeCodeOauth) {
    const creds = await loadClaudeCodeCredentials(
      an.claudeCodeCredentialsPath ? { path: an.claudeCodeCredentialsPath } : {}
    );
    if (creds.ok) {
      out.anthropic = createAnthropicProvider({
        auth: { kind: 'oauth', accessToken: creds.value.accessToken },
        baseUrl: an.baseUrl
      });
    }
  }

  // Codex / ChatGPT runtime — uses the ChatGPT OAuth token to talk to
  // `chatgpt.com/backend-api/codex/responses`. Token refreshes are
  // persisted back to ~/.atlas/config.yaml so subsequent runs (and
  // long sessions that outlive the access-token TTL) keep working.
  const codexAuth = cfg.providers.openai?.codex;
  if (codexAuth?.accessToken) {
    let snap = {
      accessToken: codexAuth.accessToken,
      ...(codexAuth.refreshToken !== undefined ? { refreshToken: codexAuth.refreshToken } : {}),
      ...(codexAuth.idToken !== undefined ? { idToken: codexAuth.idToken } : {}),
      ...(codexAuth.accountId !== undefined ? { accountId: codexAuth.accountId } : {}),
      ...(typeof codexAuth.expiresAt === 'number' ? { expiresAt: codexAuth.expiresAt } : {})
    };
    out['openai-codex'] = createCodexProvider({
      baseUrl: cfg.providers.openai.baseUrl,
      tokens: {
        read: () => snap,
        write: async (next) => {
          snap = next;
          // Best-effort persistence — refresh failures shouldn't crash
          // the chat loop. We re-read the latest cfg from disk so we
          // don't clobber concurrent edits.
          const latest = await loadConfig();
          if (!latest.ok) return;
          const merged = {
            ...latest.value,
            providers: {
              ...latest.value.providers,
              openai: {
                ...latest.value.providers.openai,
                codex: {
                  accessToken: next.accessToken,
                  ...(next.refreshToken !== undefined ? { refreshToken: next.refreshToken } : {}),
                  ...(next.idToken !== undefined ? { idToken: next.idToken } : {}),
                  ...(next.accountId !== undefined ? { accountId: next.accountId } : {}),
                  ...(next.expiresAt !== undefined ? { expiresAt: next.expiresAt } : {})
                }
              }
            }
          };
          await saveConfig(merged);
        }
      }
    });
  }

  // Local / Ollama provider — added when autoDetect is on or the user
  // has explicitly set defaultProvider: local. A second call to probe
  // is avoided: buildAllProviders runs after maybeAutoDetectLocal which
  // already confirmed reachability. We construct the provider object so
  // the factory switch in providerFromConfig has something to return.
  const lo = cfg.providers.local;
  if (cfg.defaultProvider === 'local' || lo.autoDetect) {
    out.local = createLocalProvider({
      baseUrl: lo.baseUrl,
      ...(lo.apiKey ? { apiKey: lo.apiKey } : {}),
      ...(Object.keys(lo.headers).length > 0 ? { headers: lo.headers } : {}),
      toolMode: lo.toolMode,
      requestTimeoutMs: lo.requestTimeoutMs
    });
  }

  const zen = cfg.providers.opencode.zen;
  if (zen.apiKey) {
    out['opencode-zen'] = createOpenCodeProvider({
      plan: 'zen',
      apiKey: zen.apiKey,
      baseUrl: zen.baseUrl
    });
  }

  const go = cfg.providers.opencode.go;
  if (go.apiKey) {
    out['opencode-go'] = createOpenCodeProvider({
      plan: 'go',
      apiKey: go.apiKey,
      baseUrl: go.baseUrl
    });
  }

  return out;
};
