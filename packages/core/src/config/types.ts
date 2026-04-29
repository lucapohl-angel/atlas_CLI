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
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  /** When false, the server is listed but not spawned. */
  enabled: z.boolean().default(true)
});

export const McpConfigSchema = z
  .object({
    servers: z.array(McpServerConfigSchema).default([])
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

export const AtlasConfigSchema = z
  .object({
    defaultProvider: z.enum(['openrouter', 'anthropic']).default('openrouter'),
    defaultModel: z.string().min(1).default('anthropic/claude-sonnet-4'),
    /** Models to try in order if the primary fails (429 / 5xx / network). */
    fallbackModels: z.array(z.string().min(1)).default([]),
    providers: ProvidersConfigSchema,
    mcp: McpConfigSchema,
    github: GitHubAuthConfigSchema
  })
  .default({});

export type OpenRouterProviderConfig = z.infer<typeof OpenRouterProviderConfigSchema>;
export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderConfigSchema>;
export type OpenAIProviderConfig = z.infer<typeof OpenAIProviderConfigSchema>;
export type OpenAICodexAuth = z.infer<typeof OpenAICodexAuthSchema>;
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type GitHubAuthConfig = z.infer<typeof GitHubAuthConfigSchema>;
export type AtlasConfig = z.infer<typeof AtlasConfigSchema>;
