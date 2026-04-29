/**
 * Claude Code OAuth credential reader.
 *
 * If the user has the `claude` CLI installed and signed in, their OAuth
 * token is at `~/.claude/.credentials.json` in this shape:
 *
 *   {
 *     "claudeAiOauth": {
 *       "accessToken": "sk-ant-oat01-...",
 *       "refreshToken": "sk-ant-ort01-...",
 *       "expiresAt": 1730000000000,
 *       "scopes": ["user:inference", "user:profile"],
 *       "subscriptionType": "max"
 *     }
 *   }
 *
 * Atlas reuses that token to call Anthropic directly, so a Claude Code
 * subscriber doesn't need a separate ANTHROPIC_API_KEY.
 *
 * Refresh-on-expiry is delegated back to the user — when the token is
 * stale we surface a friendly error suggesting `claude` to re-auth.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';

export const DEFAULT_CLAUDE_CREDENTIALS_PATH: string = join(
  homedir(),
  '.claude',
  '.credentials.json'
);

const CredentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().optional(),
    expiresAt: z.number().int().optional(),
    scopes: z.array(z.string()).optional(),
    subscriptionType: z.string().optional()
  })
});

export interface ClaudeCodeCredentials {
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly subscriptionType?: string;
  readonly path: string;
}

export interface LoadClaudeCodeOptions {
  /** Override the credentials path (testing). */
  readonly path?: string;
}

export const loadClaudeCodeCredentials = async (
  opts: LoadClaudeCodeOptions = {}
): Promise<Result<ClaudeCodeCredentials, AtlasError>> => {
  const path = opts.path ?? DEFAULT_CLAUDE_CREDENTIALS_PATH;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      return err(
        atlasError(
          'PROVIDER_AUTH_FAILED',
          `Claude Code credentials not found at ${path}. Install Claude Code (https://claude.com/claude-code) and run \`claude\` once to sign in.`,
          { context: { path } }
        )
      );
    }
    return err(
      atlasError('PROVIDER_AUTH_FAILED', `failed to read ${path}`, { cause: e, context: { path } })
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return err(
      atlasError('PROVIDER_AUTH_FAILED', `invalid JSON in ${path}`, { cause: e, context: { path } })
    );
  }

  const parsed = CredentialsSchema.safeParse(json);
  if (!parsed.success) {
    return err(
      atlasError(
        'PROVIDER_AUTH_FAILED',
        `unrecognized Claude Code credential shape at ${path}`,
        { context: { path, issues: parsed.error.issues } }
      )
    );
  }

  const oauth = parsed.data.claudeAiOauth;
  // Note: we deliberately do NOT hard-fail on `expiresAt < now`. Clock
  // skew is common and the token may still be valid; if it isn't, the
  // Anthropic API will return 401 and we surface that to the user with
  // an actionable message. Hard-failing here would mean the TUI can't
  // even start when the local clock is a minute off.

  const result: ClaudeCodeCredentials = {
    accessToken: oauth.accessToken,
    path,
    ...(oauth.expiresAt !== undefined ? { expiresAt: oauth.expiresAt } : {}),
    ...(oauth.subscriptionType !== undefined ? { subscriptionType: oauth.subscriptionType } : {})
  };
  return ok(result);
};
