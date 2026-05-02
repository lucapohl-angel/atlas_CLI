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
    /** ChatGPT OAuth credentials (Codex flow). */
    codex: OpenAICodexAuthSchema,
    baseUrl: z.string().url().default('https://chatgpt.com/backend-api/codex')
  })
  .default({});

export const ProvidersConfigSchema = z
  .object({
    openrouter: OpenRouterProviderConfigSchema,
    anthropic: AnthropicProviderConfigSchema,
    openai: OpenAIProviderConfigSchema
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
    autoResolve: z.enum(['abort', 'ours', 'theirs', 'ai']).default('abort')
  })
  .default({});

export const AtlasConfigSchema = z
  .object({
    defaultProvider: z.enum(['openrouter', 'anthropic']).default('openrouter'),
    defaultModel: z.string().min(1).default('anthropic/claude-sonnet-4'),
    /** Models to try in order if the primary fails (429 / 5xx / network). */
    fallbackModels: z.array(z.string().min(1)).default([]),
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
export type OpenAICodexAuth = z.infer<typeof OpenAICodexAuthSchema>;
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;
export type GitHubAuthConfig = z.infer<typeof GitHubAuthConfigSchema>;
export type GuardrailsConfig = z.infer<typeof GuardrailsConfigSchema>;
export type ShipConfig = z.infer<typeof ShipConfigSchema>;
export type AtlasConfig = z.infer<typeof AtlasConfigSchema>;
