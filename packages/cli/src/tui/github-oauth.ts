/**
 * GitHub OAuth Device Flow.
 *
 * The user-facing experience is the same one you get from `gh auth
 * login --web`:
 *   1. We POST to /login/device/code to get a short user_code and a
 *      verification URL.
 *   2. We open the URL in the user's browser. They sign in (if needed),
 *      type the code, and click "Authorize".
 *   3. We poll /login/oauth/access_token until the user accepts (or the
 *      code expires / they deny / they cancel).
 *   4. We hand the resulting access token back to the caller — no PAT
 *      to copy/paste, no scopes screen to navigate.
 *
 * Client ID
 * ─────────
 * Device flow requires a registered OAuth App's `client_id`. We default
 * to GitHub CLI's well-known public client_id (`Iv1.b507a08c87ecfe98`,
 * documented in the cli/cli source tree, MIT-licensed). The trade-off:
 * the consent screen will say "GitHub CLI" instead of "Atlas". Users
 * who want their own attribution can register an OAuth App at
 * github.com/settings/developers and set ATLAS_GITHUB_CLIENT_ID before
 * launching atlas.
 */

const DEFAULT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const DEFAULT_SCOPES = 'repo,read:org,workflow,gist';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export interface GithubDeviceFlowOptions {
  /** Defaults to `process.env.ATLAS_GITHUB_CLIENT_ID` or gh CLI's id. */
  readonly clientId?: string;
  /** Comma-separated scope list. Defaults to repo,read:org,workflow,gist. */
  readonly scopes?: string;
  readonly signal?: AbortSignal;
}

export type GithubDeviceFlowEvent =
  | {
      readonly type: 'code';
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresInSeconds: number;
      readonly intervalSeconds: number;
    }
  | { readonly type: 'polling'; readonly elapsedSeconds: number }
  | { readonly type: 'authorized'; readonly accessToken: string; readonly scope: string }
  | { readonly type: 'denied' }
  | { readonly type: 'expired' }
  | { readonly type: 'cancelled' }
  | { readonly type: 'error'; readonly message: string };

interface DeviceCodeResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly expires_in: number;
  readonly interval: number;
}

interface AccessTokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
  readonly error?: string;
  readonly error_description?: string;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export async function* runGithubDeviceFlow(
  opts: GithubDeviceFlowOptions = {}
): AsyncGenerator<GithubDeviceFlowEvent, void, void> {
  const clientId = opts.clientId ?? process.env.ATLAS_GITHUB_CLIENT_ID ?? DEFAULT_CLIENT_ID;
  const scopes = opts.scopes ?? DEFAULT_SCOPES;
  const signal = opts.signal;

  // Step 1 — request a device code.
  let deviceCode: DeviceCodeResponse;
  try {
    const res = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ client_id: clientId, scope: scopes }).toString(),
      signal
    });
    if (!res.ok) {
      yield {
        type: 'error',
        message: `device code request failed: HTTP ${res.status} ${res.statusText}`
      };
      return;
    }
    deviceCode = (await res.json()) as DeviceCodeResponse;
    if (!deviceCode.device_code || !deviceCode.user_code) {
      yield { type: 'error', message: 'invalid device code response from GitHub' };
      return;
    }
  } catch (e) {
    if (signal?.aborted) {
      yield { type: 'cancelled' };
      return;
    }
    yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
    return;
  }

  yield {
    type: 'code',
    userCode: deviceCode.user_code,
    verificationUri: deviceCode.verification_uri,
    expiresInSeconds: deviceCode.expires_in,
    intervalSeconds: deviceCode.interval
  };

  // Step 2 — poll for the access token.
  let intervalMs = Math.max(1, deviceCode.interval) * 1000;
  const startedAt = Date.now();
  const deadline = startedAt + deviceCode.expires_in * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      yield { type: 'cancelled' };
      return;
    }
    try {
      await sleep(intervalMs, signal);
    } catch {
      yield { type: 'cancelled' };
      return;
    }

    yield { type: 'polling', elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) };

    let body: AccessTokenResponse;
    try {
      const res = await fetch(ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: deviceCode.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        }).toString(),
        signal
      });
      if (!res.ok) {
        // Transient — keep polling. GitHub occasionally returns 5xx.
        continue;
      }
      body = (await res.json()) as AccessTokenResponse;
    } catch (e) {
      if (signal?.aborted) {
        yield { type: 'cancelled' };
        return;
      }
      // Network blip — keep trying until the deadline.
      yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
      continue;
    }

    if (body.access_token) {
      yield {
        type: 'authorized',
        accessToken: body.access_token,
        scope: body.scope ?? scopes
      };
      return;
    }

    switch (body.error) {
      case 'authorization_pending':
        // User hasn't entered the code yet — keep polling at current interval.
        continue;
      case 'slow_down':
        // GitHub asks us to back off by at least 5 seconds.
        intervalMs += 5_000;
        continue;
      case 'expired_token':
        yield { type: 'expired' };
        return;
      case 'access_denied':
        yield { type: 'denied' };
        return;
      case 'unsupported_grant_type':
      case 'incorrect_client_credentials':
      case 'incorrect_device_code':
      default:
        yield {
          type: 'error',
          message: body.error_description ?? body.error ?? 'unknown error from GitHub'
        };
        return;
    }
  }

  yield { type: 'expired' };
}
