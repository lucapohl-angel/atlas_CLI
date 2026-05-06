/**
 * Provider barrel. Higher-level callers should prefer `providerFromConfig`
 * which materializes a Provider from an `AtlasConfig` and (optionally)
 * Claude Code OAuth credentials.
 */
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type { AtlasConfig } from '../config/types.js';
import { createOpenRouterProvider } from './openrouter.js';
import { createAnthropicProvider } from './anthropic.js';
import { createLocalProvider } from './local.js';
import { loadClaudeCodeCredentials } from './claude-code.js';
import type { Provider } from './types.js';

export * from './types.js';
export * from './openrouter.js';
export * from './anthropic.js';
export * from './local.js';
export * from './claude-code.js';
export * from './pricing.js';
export * from './catalog.js';
export * from './codex-oauth.js';
export * from './codex.js';

/**
 * Synchronous provider factory.
 *
 * For Anthropic with Claude Code OAuth, use `providerFromConfigAsync` —
 * loading credentials requires a filesystem read.
 */
export const providerFromConfig = (cfg: AtlasConfig): Result<Provider, AtlasError> => {
  switch (cfg.defaultProvider) {
    case 'openrouter': {
      const or = cfg.providers.openrouter;
      if (!or.apiKey) {
        return err(
          atlasError(
            'PROVIDER_AUTH_FAILED',
            'OpenRouter API key missing — set OPENROUTER_API_KEY or providers.openrouter.apiKey in ~/.atlas/config.yaml'
          )
        );
      }
      return ok(
        createOpenRouterProvider({
          apiKey: or.apiKey,
          ...(or.apiKeys.length > 0 ? { fallbackKeys: or.apiKeys } : {}),
          baseUrl: or.baseUrl,
          ...(or.referer !== undefined ? { referer: or.referer } : {}),
          title: or.title
        })
      );
    }
    case 'anthropic': {
      const an = cfg.providers.anthropic;
      if (an.apiKey) {
        return ok(
          createAnthropicProvider({
            auth: {
              kind: 'apiKey',
              apiKey: an.apiKey,
              ...(an.apiKeys.length > 0 ? { fallbackKeys: an.apiKeys } : {})
            },
            baseUrl: an.baseUrl
          })
        );
      }
      return err(
        atlasError(
          'PROVIDER_AUTH_FAILED',
          'Anthropic provider requires either an API key or Claude Code OAuth (use providerFromConfigAsync to read OAuth credentials).'
        )
      );
    }
    case 'local': {
      const lo = cfg.providers.local;
      return ok(
        createLocalProvider({
          baseUrl: lo.baseUrl,
          ...(lo.apiKey ? { apiKey: lo.apiKey } : {}),
          ...(Object.keys(lo.headers).length > 0 ? { headers: lo.headers } : {}),
          liteMode: lo.liteMode,
          requestTimeoutMs: lo.requestTimeoutMs
        })
      );
    }
    default:
      return err(
        atlasError('CONFIG_INVALID', `unknown provider: ${String(cfg.defaultProvider)}`)
      );
  }
};

/**
 * Async provider factory — same as `providerFromConfig` but reads
 * Claude Code OAuth credentials from disk when the Anthropic provider
 * has no apiKey and `useClaudeCodeOauth` is enabled.
 */
export const providerFromConfigAsync = async (
  cfg: AtlasConfig
): Promise<Result<Provider, AtlasError>> => {
  if (cfg.defaultProvider !== 'anthropic') return providerFromConfig(cfg);

  const an = cfg.providers.anthropic;
  if (an.apiKey) {
    return ok(
      createAnthropicProvider({
        auth: {
          kind: 'apiKey',
          apiKey: an.apiKey,
          ...(an.apiKeys.length > 0 ? { fallbackKeys: an.apiKeys } : {})
        },
        baseUrl: an.baseUrl
      })
    );
  }
  if (!an.useClaudeCodeOauth) {
    return err(
      atlasError(
        'PROVIDER_AUTH_FAILED',
        'Anthropic provider requires an API key (set providers.anthropic.apiKey or ANTHROPIC_API_KEY).'
      )
    );
  }
  const creds = await loadClaudeCodeCredentials(
    an.claudeCodeCredentialsPath ? { path: an.claudeCodeCredentialsPath } : {}
  );
  if (!creds.ok) return err(creds.error);
  return ok(
    createAnthropicProvider({
      auth: { kind: 'oauth', accessToken: creds.value.accessToken },
      baseUrl: an.baseUrl
    })
  );
};
