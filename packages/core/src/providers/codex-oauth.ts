/**
 * ChatGPT / Codex OAuth (PKCE) helper.
 *
 * Mirrors the flow used by OpenAI's open-source Codex CLI and by
 * opencode: the user signs in with their ChatGPT account at
 * `auth.openai.com`, and we receive a short-lived access token + a
 * refresh token usable against the Responses API on
 * `chatgpt.com/backend-api/codex`.
 *
 * Security notes:
 * - PKCE (RFC 7636) is mandatory — no client secret is shipped.
 * - The redirect listener binds to `127.0.0.1` (loopback only).
 * - The `state` parameter is verified before accepting the code.
 * - Token storage is the caller's responsibility (see codex provider /
 *   ~/.atlas/config.yaml). Keep mode 0600 on disk.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import { err, ok, type Result } from '../result.js';

const log = childLogger('oauth:codex');

/**
 * The Codex CLI client_id is a publicly known identifier (it ships in
 * the open-source Codex CLI binary). It's not a secret — PKCE replaces
 * the need for one.
 */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTH_HOST = 'https://auth.openai.com';
export const CODEX_REDIRECT_PORT = 1455;
export const CODEX_REDIRECT_PATH = '/auth/callback';
/**
 * Codex CLI registers `localhost` (not `127.0.0.1`) as the allowed
 * redirect host for this client_id. Using a different host triggers
 * `unknown_error` on the OpenAI authorize page.
 */
export const CODEX_REDIRECT_URI = `http://localhost:${CODEX_REDIRECT_PORT}${CODEX_REDIRECT_PATH}`;
/**
 * Scopes must match the Codex CLI exactly. The `api.connectors.*` scopes
 * are required by the OpenAI authorize endpoint for this client_id;
 * dropping them returns `unknown_error`.
 */
export const CODEX_SCOPES =
  'openid profile email offline_access api.connectors.read api.connectors.invoke';
/** Codex CLI originator string. Required by the authorize endpoint. */
export const CODEX_ORIGINATOR = 'codex_cli_rs';

export interface CodexTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly expiresAt: number; // epoch ms
  readonly accountId?: string;
}

export interface BeginCodexLoginOptions {
  /** Redirect port override (testing). */
  readonly port?: number;
  /** Override the auth host (testing). */
  readonly authHost?: string;
  /** Override fetch (testing). */
  readonly fetch?: typeof fetch;
  /** Browser opener override (testing). Defaults to noop — caller prints URL. */
  readonly openBrowser?: (url: string) => Promise<void> | void;
  readonly signal?: AbortSignal;
  /** Total timeout for the whole flow. Default 5 min. */
  readonly timeoutMs?: number;
}

export interface CodexLoginHandle {
  /** URL to display / open. */
  readonly authorizeUrl: string;
  /** Resolves once the user completes the flow (or rejects on timeout/error). */
  readonly tokens: Promise<Result<CodexTokens, AtlasError>>;
  /** Cancel the in-progress flow and tear down the listener. */
  readonly cancel: () => void;
}

const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Start the PKCE flow. Returns the URL the user should visit and a
 * promise that settles when the redirect is received (or the flow
 * times out / is cancelled). The caller is responsible for actually
 * opening the URL in a browser if desired — the helper only spins up
 * the loopback HTTP listener.
 */
export const beginCodexLogin = (
  options: BeginCodexLoginOptions = {}
): CodexLoginHandle => {
  const port = options.port ?? CODEX_REDIRECT_PORT;
  const host = options.authHost ?? CODEX_AUTH_HOST;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(32));
  const redirectUri = `http://localhost:${port}${CODEX_REDIRECT_PATH}`;

  // Order and exact param set mirror the open-source Codex CLI
  // (`codex-rs/login/src/server.rs::build_authorize_url`). The OpenAI
  // authorize endpoint validates this allow-list per client_id and
  // returns a generic `unknown_error` page if anything is missing.
  const authorizeParams = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CODEX_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: CODEX_ORIGINATOR
  });
  const authorizeUrl = `${host}/oauth/authorize?${authorizeParams.toString()}`;

  let cancelled = false;
  let resolveOuter!: (r: Result<CodexTokens, AtlasError>) => void;
  const tokens = new Promise<Result<CodexTokens, AtlasError>>((resolve) => {
    resolveOuter = resolve;
  });

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!req.url) {
        res.writeHead(400).end('bad request');
        return;
      }
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== CODEX_REDIRECT_PATH) {
        res.writeHead(404).end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const errorParam = url.searchParams.get('error');
      if (errorParam) {
        const desc = url.searchParams.get('error_description') ?? errorParam;
        res
          .writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
          .end(renderResultPage(false, `Login failed: ${desc}`));
        finish(err(atlasError('PROVIDER_AUTH_FAILED', `OpenAI login failed: ${desc}`)));
        return;
      }
      if (!code || returnedState !== state) {
        res
          .writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
          .end(renderResultPage(false, 'Invalid state or missing code.'));
        finish(err(atlasError('PROVIDER_AUTH_FAILED', 'OAuth state mismatch — possible CSRF; aborting')));
        return;
      }

      const tokenRes = await doFetch(`${host}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: CODEX_CLIENT_ID,
          code_verifier: verifier
        }).toString()
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => '');
        res
          .writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
          .end(renderResultPage(false, `Token exchange failed (${tokenRes.status}).`));
        finish(
          err(
            atlasError(
              'PROVIDER_AUTH_FAILED',
              `OpenAI token exchange failed: ${tokenRes.status} ${text.slice(0, 200)}`
            )
          )
        );
        return;
      }

      const json = (await tokenRes.json()) as Record<string, unknown>;
      const accessToken = typeof json['access_token'] === 'string' ? json['access_token'] : '';
      if (!accessToken) {
        res
          .writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
          .end(renderResultPage(false, 'Server returned no access_token.'));
        finish(err(atlasError('PROVIDER_AUTH_FAILED', 'OpenAI returned no access_token')));
        return;
      }
      const refreshToken =
        typeof json['refresh_token'] === 'string' ? json['refresh_token'] : undefined;
      const idToken = typeof json['id_token'] === 'string' ? json['id_token'] : undefined;
      const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
      const accountId =
        typeof json['account_id'] === 'string' ? json['account_id'] : undefined;

      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(renderResultPage(true, 'You are signed in. You can close this tab and return to Atlas.'));

      finish(
        ok({
          accessToken,
          ...(refreshToken !== undefined ? { refreshToken } : {}),
          ...(idToken !== undefined ? { idToken } : {}),
          expiresAt: Date.now() + expiresIn * 1000,
          ...(accountId !== undefined ? { accountId } : {})
        })
      );
    } catch (e) {
      log.error({ e }, 'callback handler crashed');
      try {
        res.writeHead(500).end('internal error');
      } catch {
        /* socket likely already closed */
      }
      finish(err(atlasError('PROVIDER_AUTH_FAILED', 'OAuth callback crashed', { cause: e })));
    }
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  const finish = (r: Result<CodexTokens, AtlasError>): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    server.close();
    resolveOuter(r);
  };

  server.on('error', (e) => {
    finish(err(atlasError('PROVIDER_AUTH_FAILED', 'OAuth listener error', { cause: e })));
  });
  server.listen(port, '127.0.0.1', () => {
    log.debug({ port }, 'oauth listener started');
    if (options.openBrowser) {
      void Promise.resolve(options.openBrowser(authorizeUrl)).catch((e) => {
        log.warn({ e }, 'openBrowser failed (URL still printed)');
      });
    }
  });

  timer = setTimeout(() => {
    finish(err(atlasError('PROVIDER_AUTH_FAILED', `OAuth flow timed out after ${timeoutMs}ms`)));
  }, timeoutMs);

  if (options.signal) {
    const onAbort = (): void => {
      cancelled = true;
      finish(err(atlasError('CANCELLED', 'OAuth flow cancelled')));
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    authorizeUrl,
    tokens,
    cancel: () => {
      if (!cancelled) {
        cancelled = true;
        finish(err(atlasError('CANCELLED', 'OAuth flow cancelled')));
      }
    }
  };
};

/**
 * Refresh an expired Codex access token. Returns a fresh `CodexTokens`
 * record. Caller persists the result.
 */
export const refreshCodexTokens = async (
  refreshToken: string,
  options: { readonly fetch?: typeof fetch; readonly authHost?: string } = {}
): Promise<Result<CodexTokens, AtlasError>> => {
  const host = options.authHost ?? CODEX_AUTH_HOST;
  const doFetch = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${host}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
        scope: CODEX_SCOPES
      }).toString()
    });
  } catch (e) {
    return err(atlasError('PROVIDER_NETWORK', 'network error refreshing Codex token', { cause: e }));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return err(
      atlasError(
        'PROVIDER_AUTH_FAILED',
        `Codex token refresh failed: ${res.status} ${text.slice(0, 200)}`
      )
    );
  }
  const json = (await res.json()) as Record<string, unknown>;
  const accessToken = typeof json['access_token'] === 'string' ? json['access_token'] : '';
  if (!accessToken) {
    return err(atlasError('PROVIDER_AUTH_FAILED', 'Codex refresh returned no access_token'));
  }
  const newRefresh =
    typeof json['refresh_token'] === 'string' ? json['refresh_token'] : refreshToken;
  const idToken = typeof json['id_token'] === 'string' ? json['id_token'] : undefined;
  const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
  return ok({
    accessToken,
    refreshToken: newRefresh,
    ...(idToken !== undefined ? { idToken } : {}),
    expiresAt: Date.now() + expiresIn * 1000
  });
};

const renderResultPage = (success: boolean, message: string): string => {
  const color = success ? '#16a34a' : '#dc2626';
  const icon = success ? '✓' : '✗';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Atlas — ${success ? 'Signed in' : 'Login failed'}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
         display: flex; align-items: center; justify-content: center;
         min-height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5; }
  .card { padding: 2.5rem 3rem; background: #171717; border-radius: 12px;
          border: 1px solid #262626; text-align: center; max-width: 28rem; }
  .icon { font-size: 3rem; color: ${color}; margin-bottom: 0.5rem; }
  h1 { margin: 0 0 0.5rem; font-weight: 600; }
  p { color: #a3a3a3; margin: 0.5rem 0 0; line-height: 1.5; }
</style></head>
<body><div class="card"><div class="icon">${icon}</div>
<h1>${success ? 'Signed in to ChatGPT' : 'Login failed'}</h1>
<p>${escapeHtml(message)}</p></div></body></html>`;
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
