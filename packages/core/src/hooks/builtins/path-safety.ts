/**
 * Path-safety guardrail.
 *
 * Fires on `beforeTool` for `read_file` and `write_file`. Blocks paths
 * that resolve outside the project cwd, into the user's SSH/GPG/cloud
 * credential dirs, or into well-known secret files (.env, *.pem,
 * id_rsa, etc.). The individual tool implementations already reject
 * `..` escapes — this hook is the second layer that protects absolute
 * paths and credential filenames anywhere on disk.
 */
import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve } from 'node:path';
import type { HookSpec } from '../types.js';

const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\.[a-z0-9_-]+)?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.pgpass$/i,
  /(^|\/)credentials(\.json|\.yaml|\.yml)?$/i
];

const denyHomeRelative = (p: string): string | null => {
  const home = homedir();
  const denied = [
    '.ssh',
    '.gnupg',
    '.aws',
    '.config/gcloud',
    '.docker/config.json',
    '.kube/config',
    '.npmrc',
    '.pypirc'
  ];
  for (const d of denied) {
    const abs = resolve(home, d);
    if (p === abs || p.startsWith(abs + '/')) return d;
  }
  return null;
};

export const pathSafetyHook = (
  cwd: string,
  extraDenied: readonly string[] = []
): HookSpec<'beforeTool'> => ({
  event: 'beforeTool',
  matcher: /^(read_file|write_file)$/,
  handler: (ctx) => {
    const input = ctx.input as { path?: unknown } | null;
    if (!input || typeof input.path !== 'string' || input.path.length === 0) {
      return { action: 'allow' };
    }
    const raw = input.path;
    const abs = normalize(isAbsolute(raw) ? raw : resolve(cwd, raw));

    // Outside cwd? Allow read of system docs, but never write.
    const insideCwd = abs === cwd || abs.startsWith(cwd + '/');
    if (!insideCwd && ctx.tool === 'write_file') {
      return {
        action: 'block',
        reason: `path-safety guardrail: write_file outside project cwd refused (${raw}).`
      };
    }

    const homeHit = denyHomeRelative(abs);
    if (homeHit) {
      return {
        action: 'block',
        reason: `path-safety guardrail: refused access to ~/${homeHit} (credentials).`
      };
    }

    // .git internals
    if (abs.includes('/.git/') && ctx.tool === 'write_file') {
      return {
        action: 'block',
        reason: 'path-safety guardrail: write_file into .git/ refused.'
      };
    }

    for (const re of SECRET_FILE_PATTERNS) {
      if (re.test(abs)) {
        return {
          action: 'block',
          reason: `path-safety guardrail: refused secret-file path (${raw}).`
        };
      }
    }

    for (const needle of extraDenied) {
      if (abs.includes(needle)) {
        return {
          action: 'block',
          reason: `path-safety guardrail: matched user-denied path fragment "${needle}".`
        };
      }
    }

    return { action: 'allow' };
  }
});
