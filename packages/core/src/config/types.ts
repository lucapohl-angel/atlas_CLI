/**
 * Atlas configuration schema.
 *
 * The user-facing config lives at `~/.atlas/config.yaml`. Anything
 * crossing that boundary is parsed through Zod so we never trust raw
 * input. Environment variables (e.g. OPENROUTER_API_KEY) override file
 * values during load — see config/load.ts.
 */
import { z } from 'zod';

export const OpenRouterProviderConfigSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    /**
     * Optional list of additional API keys. When the primary key returns
     * 429/401, Atlas rotates to the next entry. Combined order is:
     * [apiKey, ...apiKeys].
     */
    apiKeys: z.array(z.string().min(1)).default([]),
    baseUrl: z.string().url().default('https://openrouter.ai/api/v1'),
    /** Sent as HTTP-Referer on OpenRouter requests (optional, used for ranking). */
    referer: z.string().optional(),
    /** Sent as X-Title on OpenRouter requests (optional, used for ranking). */
    title: z.string().default('Atlas CLI'),
    /**
     * Model ids the user has added via the in-TUI "+ Add custom model id…"
     * picker entry. Persisted across restarts and surfaced at the top of
     * the model picker.
     */
    customModels: z.array(z.string().min(1)).default([])
  })
  .default({});

export const AnthropicProviderConfigSchema = z
  .object({
    /** Direct Anthropic API key. Overrides OAuth if both present. */
    apiKey: z.string().min(1).optional(),
    /** Additional fallback keys, rotated on 429/401. */
    apiKeys: z.array(z.string().min(1)).default([]),
    /**
     * If true (default), and no apiKey is set, Atlas will look for Claude
     * Code OAuth credentials at ~/.claude/.credentials.json so subscribers
     * don't need a separate key.
     */
    useClaudeCodeOauth: z.boolean().default(true),
    /** Override the credentials path (testing / non-default install). */
    claudeCodeCredentialsPath: z.string().optional(),
    baseUrl: z.string().url().default('https://api.anthropic.com')
  })
  .default({});

export const McpServerConfigSchema = z.object({
  name: z.string().min(1),
  /**
   * Transport kind. `stdio` (default) spawns `command` as a subprocess.
   * `http` posts JSON-RPC to `url` (Streamable HTTP transport, spec
   * 2025-03-26) — used for hosted servers like Higgsfield and Figma.
   */
  transport: z.enum(['stdio', 'http']).default('stdio'),
  // stdio fields:
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  // http fields:
  url: z.string().url().optional(),
  /** Static request headers (e.g. `Authorization: Bearer <token>`). */
  headers: z.record(z.string()).default({}),
  /** When false, the server is listed but not spawned. */
  enabled: z.boolean().default(true)
});

export const McpConfigSchema = z
  .object({
    servers: z.array(McpServerConfigSchema).default([]),
    /**
     * Set to true the first time atlas auto-seeds the default built-in
     * MCP servers (currently: `memory`). Prevents re-adding them if the
     * user later removes them. Users who never want defaults can set
     * this to true manually in their config.
     */
    builtinsSeeded: z.boolean().default(false)
  })
  .default({});

export const CompactionConfigSchema = z
  .object({
    /** Master switch. When false, no auto-compaction is attempted. */
    enabled: z.boolean().default(true),
    /**
     * Override model id used for the summarizer. When omitted, Atlas
     * uses the **active** chat model (no separate cheap summarizer).
     */
    model: z.string().min(1).optional(),
    /**
     * Fraction of the context window that triggers compaction. Default
     * 0.8 (compact when ≥ 80% full). Clamped to (0, 1].
     */
    threshold: z.number().gt(0).lte(1).default(0.8),
    /**
     * Assumed context window size in tokens (used for the threshold
     * calculation when the provider doesn't report it). Default 200k.
     */
    contextTokens: z.number().int().positive().default(200_000)
  })
  .default({});

export const AtlasPowerModeSchema = z.enum(['full', 'smart']);

export const ATLAS_POWER_MODE_SPECS: Record<
  z.infer<typeof AtlasPowerModeSchema>,
  {
    readonly label: string;
    readonly costEstimate: string;
    readonly pros: string;
    readonly cons: string;
  }
> = {
  full: {
    label: 'Atlas Power Full',
    costEstimate:
      'roughly 100k-250k input tokens on heavy turns before cache; cache-capable models make repeat turns much cheaper',
    pros: 'maximum Atlas context, tools, MCP, hooks, and predictable behavior',
    cons: 'largest token payload; no-cache models rebill the full prefix each message'
  },
  smart: {
    label: 'Atlas Smart Mode',
    costEstimate:
      'roughly 20k-80k input tokens on normal hosted turns; complex turns can still pay Full Atlas costs',
    pros: 'cost-aware default for daily hosted work; favors cache-friendly model choices',
    cons: 'adaptive strategy; very complex work may still need the full prompt/tool surface'
  }
};

export const GitHubAuthConfigSchema = z
  .object({
    /** OAuth access token obtained via the device-flow setup. */
    token: z.string().min(1).optional(),
    /** GitHub login the token belongs to (for display only). */
    login: z.string().optional(),
    /** ISO timestamp the token was minted at. */
    obtainedAt: z.string().optional()
  })
  .default({});

export const OpenAICodexAuthSchema = z
  .object({
    /** OAuth access token from the ChatGPT/Codex PKCE flow. */
    accessToken: z.string().min(1).optional(),
    /** Refresh token used to mint new access tokens after expiry. */
    refreshToken: z.string().min(1).optional(),
    /** Decoded id_token (optional, useful for showing user identity). */
    idToken: z.string().min(1).optional(),
    /** Account/org id returned by the token endpoint. */
    accountId: z.string().optional(),
    /** Epoch ms when the access token expires. */
    expiresAt: z.number().int().optional()
  })
  .default({});

export const OpenAIProviderConfigSchema = z
  .object({
    /** Direct OpenAI API key. Used for api.openai.com/v1 when authMode is apiKey or auto. */
    apiKey: z.string().min(1).optional(),
    /** Direct OpenAI API base URL for API-key auth. */
    apiBaseUrl: z.string().url().default('https://api.openai.com/v1'),
    /**
     * OpenAI runtime auth preference:
     * - auto: use apiKey when present, otherwise ChatGPT/Codex OAuth.
     * - apiKey: require the direct OpenAI API key.
     * - oauth: require ChatGPT/Codex OAuth.
     */
    authMode: z.enum(['auto', 'apiKey', 'oauth']).default('auto'),
    /** ChatGPT OAuth credentials (Codex flow). */
    codex: OpenAICodexAuthSchema,
    baseUrl: z.string().url().default('https://chatgpt.com/backend-api/codex')
  })
  .default({});

const createOpenCodePlanProviderConfigSchema = (baseUrl: string) =>
  z
    .object({
      apiKey: z.string().min(1).optional(),
      baseUrl: z.string().url().default(baseUrl),
      customModels: z.array(z.string().min(1)).default([])
    })
    .default({});

export const OpenCodeZenProviderConfigSchema = createOpenCodePlanProviderConfigSchema(
  'https://opencode.ai/zen/v1'
);
export const OpenCodeGoProviderConfigSchema = createOpenCodePlanProviderConfigSchema(
  'https://opencode.ai/zen/go/v1'
);

export const OpenCodeProviderConfigSchema = z
  .object({
    zen: OpenCodeZenProviderConfigSchema,
    go: OpenCodeGoProviderConfigSchema
  })
  .default({});

export const LocalProviderToolModeSchema = z.enum(['lite', 'hybrid', 'full']);

/**
 * Local / OpenAI-compatible provider — talks to Ollama by default,
 * but works with any HTTP server that speaks the OpenAI
 * `/chat/completions` SSE protocol (LM Studio, vLLM, llama.cpp
 * `server`, text-generation-webui, …).
 *
 * The default `baseUrl` points at Ollama's OpenAI-compatible bridge
 * on `http://localhost:11434/v1`, so users who install Ollama and
 * pull a model don't need to edit anything.
 */
export const LocalProviderConfigSchema = z
  .object({
    /**
     * Base URL of the OpenAI-compatible endpoint. Must include the
     * `/v1` suffix when the server requires it. Defaults to Ollama.
     */
    baseUrl: z.string().url().default('http://localhost:11434/v1'),
    /**
     * Optional bearer token. Most local servers don't need one — set
     * this only for endpoints that require auth (vLLM with
     * `--api-key`, hosted gateways, …).
     */
    apiKey: z.string().min(1).optional(),
    /** Extra static request headers (e.g. behind a private gateway). */
    headers: z.record(z.string()).default({}),
    /**
     * Auto-detect the local server on session start. When true, Atlas
     * pings `${baseUrl}/models` with a short timeout and silently
     * exposes any discovered models in the `/model` picker. No prompts,
     * no errors when nothing is running.
     */
    autoDetect: z.boolean().default(true),
    /**
     * Model ids the user has added via the in-TUI "+ Add custom model id…"
     * picker entry. Surfaced at the top of the local section.
     */
    customModels: z.array(z.string().min(1)).default([]),
    /**
     * Local tool/prompt mode:
     * - lite: compact Atlas prompt, no tool schemas. Best for CPU/low-RAM
     *   1.5 b-7 b models.
     * - hybrid: compact Atlas prompt plus a small development tool allowlist.
     *   Best for 7 b-14 b models on a GPU or fast CPU.
     * - full: full Atlas system prompt and full tool catalog. Intended for
     *   large local/hosted servers, typically 30 b-70 b+ with ample VRAM.
     */
    toolMode: LocalProviderToolModeSchema.optional(),
    /**
     * Legacy boolean alias. `true` maps to `toolMode: lite`; `false` maps
     * to `toolMode: full` when `toolMode` is not explicitly set.
     *
     * Kept so existing ~/.atlas/config.yaml files keep working.
     */
    liteMode: z.boolean().optional(),
    /**
     * Idle timeout per local model request, in milliseconds. The timer
     * resets on every byte received from the server, so this only fires
     * if the connection truly stalls. Defaults to 300 000 (5 minutes) to
     * accommodate cold model loads on low-RAM machines.
     */
    requestTimeoutMs: z.number().int().positive().default(300_000)
  })
  .default({})
  .transform((cfg) => {
    const toolMode = cfg.toolMode ?? (cfg.liteMode === false ? 'full' : 'lite');
    return {
      ...cfg,
      toolMode,
      liteMode: toolMode === 'lite'
    };
  });

export const ProvidersConfigSchema = z
  .object({
    openrouter: OpenRouterProviderConfigSchema,
    anthropic: AnthropicProviderConfigSchema,
    openai: OpenAIProviderConfigSchema,
    opencode: OpenCodeProviderConfigSchema,
    local: LocalProviderConfigSchema
  })
  .default({});

/**
 * Guardrails — automatic in-process safety hooks. All four are on by
 * default. Disable individually if a workflow legitimately needs the
 * blocked behavior (e.g. tests that scan for fake API keys).
 */
export const GuardrailsConfigSchema = z
  .object({
    /** Master switch. When false, no built-in hooks are registered. */
    enabled: z.boolean().default(true),
    /** Block obviously destructive shell / git commands. */
    dangerousCommand: z.boolean().default(true),
    /** Block writes/reads to .git, .env, ~/.ssh, outside cwd, etc. */
    pathSafety: z.boolean().default(true),
    /** Redact API keys / tokens / private keys in tool output. */
    secretRedaction: z.boolean().default(true),
    /** Flag prompt-injection markers in tool output (modify, not block). */
    promptInjectionDetector: z.boolean().default(true),
    /**
     * Enforce discover-phase guardrails: block context_set when the
     * last user reply was vague (forces the model to call clarify),
     * block context_set on likely contradictions with existing slots,
     * and warn (next turn) when an assistant message asked more than
     * one question. Disable if you want the looser prompt-only flow.
     */
    discoverGuardrails: z.boolean().default(true),
    /**
     * Auto-append a `[shortsha] subject` line to
     * `context/progress-tracker.md` § Recent Decisions after every
     * successful `git commit` invoked via the `terminal` tool. No-op
     * when the tracker file doesn't exist (i.e., no Six-File Context
     * Pack scaffolded). Set false to disable the side effect.
     */
    progressTracker: z.boolean().default(true),
    /**
     * Extra absolute paths or glob fragments to deny in path-safety
     * (in addition to built-in defaults).
     */
    extraDeniedPaths: z.array(z.string().min(1)).default([]),
    /**
     * Extra command substrings (case-insensitive) to deny in
     * dangerous-command (in addition to built-in defaults).
     */
    extraDeniedCommands: z.array(z.string().min(1)).default([])
  })
  .default({});

/**
 * Ship-time defaults — applied by `ship_apply` when the model (or the user)
 * does not pass an explicit value. Lets a vibe-coder set "always auto-resolve
 * with AI" once and forget it instead of remembering to type the option each
 * time. The model can still override per-call.
 */
export const ShipConfigSchema = z
  .object({
    /**
     * Default conflict-resolution strategy for `ship_apply mode=auto` when
     * the call doesn't specify one. `'abort'` keeps the current safe-by-default
     * behavior; `'ours'` / `'theirs'` are pure-git side-pickers; `'ai'` spawns
     * a child agent (requires the host to wire ctx.delegateRun).
     */
    autoResolve: z.enum(['abort', 'ours', 'theirs', 'ai']).default('abort'),
    /**
     * When `autoResolve` is `'abort'` and a merge conflict occurs, prompt
     * the user via the TUI to pick a resolution strategy (with an option
     * to persist their choice as the new default). When false, the tool
     * just aborts and prints the manual-resolution recipe — the original
     * pre-prompt behavior. Toggleable from the `/config` menu.
     */
    promptOnConflict: z.boolean().default(true)
  })
  .default({});

export const AtlasConfigSchema = z
  .object({
    defaultProvider: z
      .enum(['openrouter', 'anthropic', 'openai-codex', 'local', 'opencode-zen', 'opencode-go'])
      .default('openrouter'),
    defaultModel: z.string().min(1).default('anthropic/claude-sonnet-4'),
    /**
     * Optional cheaper model used for low-stakes side tasks: tool-arg
     * summarization in the TUI, todo extraction, slash-command parsing,
     * compaction summaries, and skill-learning reflection. Falls back to
     * `defaultModel` when unset. Same `provider/model` syntax as
     * `defaultModel` (e.g. `openrouter/openai/gpt-4o-mini`,
     * `anthropic/claude-haiku-4`). Set this to a Haiku/4o-mini-class
     * model to slash spend on background work without affecting the main
     * agent loop.
     */
    routerModel: z.string().min(1).optional(),
    /** Models to try in order if the primary fails (429 / 5xx / network). */
    fallbackModels: z.array(z.string().min(1)).default([]),
    /** Hosted-provider cost posture shown in /config. */
    atlasMode: AtlasPowerModeSchema.default('full'),
    providers: ProvidersConfigSchema,
    mcp: McpConfigSchema,
    github: GitHubAuthConfigSchema,
    compaction: CompactionConfigSchema,
    guardrails: GuardrailsConfigSchema,
    ship: ShipConfigSchema
  })
  .default({});

export type OpenRouterProviderConfig = z.infer<typeof OpenRouterProviderConfigSchema>;
export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderConfigSchema>;
export type OpenAIProviderConfig = z.infer<typeof OpenAIProviderConfigSchema>;
export type OpenCodeProviderConfig = z.infer<typeof OpenCodeProviderConfigSchema>;
export type OpenCodeZenProviderConfig = z.infer<typeof OpenCodeZenProviderConfigSchema>;
export type OpenCodeGoProviderConfig = z.infer<typeof OpenCodeGoProviderConfigSchema>;
export type AtlasPowerMode = z.infer<typeof AtlasPowerModeSchema>;
export type LocalProviderToolMode = z.infer<typeof LocalProviderToolModeSchema>;
export type LocalProviderConfig = z.infer<typeof LocalProviderConfigSchema>;
export type OpenAICodexAuth = z.infer<typeof OpenAICodexAuthSchema>;
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;
export type GitHubAuthConfig = z.infer<typeof GitHubAuthConfigSchema>;
export type GuardrailsConfig = z.infer<typeof GuardrailsConfigSchema>;
export type ShipConfig = z.infer<typeof ShipConfigSchema>;
export type AtlasConfig = z.infer<typeof AtlasConfigSchema>;
