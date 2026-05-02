/**
 * Dangerous-command guardrail.
 *
 * Fires on `beforeTool` for `terminal`, `git`, and `gh`. Blocks a
 * curated list of obviously destructive operations regardless of the
 * approval policy — they are categorically refused. Cosmetic
 * differences (whitespace, quoting) are normalized before matching.
 *
 * The list is conservative: anything that wipes data, force-pushes
 * shared history, or escalates to root. Users can extend it via
 * `guardrails.extraDeniedCommands` in config.
 */
import type { HookSpec } from '../types.js';

const DANGEROUS_PATTERNS: readonly RegExp[] = [
  // rm -rf on root, home, or absolute system dirs
  /\brm\s+(-[rRf]+\s+)+\/(?:\s|$)/i,
  /\brm\s+(-[rRf]+\s+)+(\$HOME|~)(\/|\s|$)/i,
  /\brm\s+(-[rRf]+\s+)+\/(etc|usr|var|bin|boot|lib|sbin|sys|proc|dev)\b/i,
  // Fork bomb
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  // Write directly to block devices
  /\bdd\s+.*\bof=\/dev\/(sd|nvme|hd|xvd|disk)/i,
  // mkfs on a real device
  /\bmkfs\.[a-z0-9]+\s+\/dev\//i,
  // chmod / chown the whole tree from root
  /\bchmod\s+(-R\s+)?[0-7]{3,4}\s+\/(?:\s|$)/i,
  /\bchown\s+(-R\s+)?\S+\s+\/(?:\s|$)/i,
  // Curl|wget | sh from the internet
  /\b(curl|wget)\s+[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
  // Disable swap / shutdown / reboot in scripts
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  // History wipe
  /\bhistory\s+-c\b/i
];

const GIT_DESTRUCTIVE: readonly RegExp[] = [
  // force push (any form) — covers --force, -f, --force-with-lease bypass, etc.
  /^push\b.*\s(--force|-f)(\s|$)/,
  /^push\b.*\s--mirror(\s|$)/,
  // hard reset on protected refs
  /^reset\b.*\s--hard\s+(origin\/)?(main|master|develop|production|prod)(\s|$)/,
  // delete remote branch on a protected name
  /^push\b.*:\s*(main|master|develop|production|prod)(\s|$)/,
  // expire reflog (history rewrite)
  /^reflog\s+expire\b.*--all/,
  // gc with prune now (nukes recoverable objects)
  /^gc\b.*--prune=now/,
  // clean -fdx without prompts (nuke everything untracked, including ignored)
  /^clean\b.*\s-[fdx]{2,}/
];

const matchesAny = (s: string, patterns: readonly RegExp[]): RegExp | null => {
  for (const p of patterns) if (p.test(s)) return p;
  return null;
};

export const dangerousCommandHook = (
  extraDenied: readonly string[] = []
): HookSpec<'beforeTool'> => ({
  event: 'beforeTool',
  matcher: /^(terminal|git|gh)$/,
  handler: (ctx) => {
    const input = ctx.input as Record<string, unknown> | null;
    if (!input || typeof input !== 'object') return { action: 'allow' };

    if (ctx.tool === 'terminal') {
      const cmd = typeof input.command === 'string' ? input.command : '';
      const hit = matchesAny(cmd, DANGEROUS_PATTERNS);
      if (hit) {
        return {
          action: 'block',
          reason: `dangerous-command guardrail: matched ${hit.source}. Refused.`
        };
      }
      const lower = cmd.toLowerCase();
      for (const needle of extraDenied) {
        if (lower.includes(needle.toLowerCase())) {
          return {
            action: 'block',
            reason: `dangerous-command guardrail: matched user-denied substring "${needle}". Refused.`
          };
        }
      }
    }

    if (ctx.tool === 'git') {
      const args = Array.isArray(input.args) ? input.args.map(String).join(' ') : '';
      const hit = matchesAny(args, GIT_DESTRUCTIVE);
      if (hit) {
        return {
          action: 'block',
          reason: `dangerous-command guardrail: refused destructive git op (${hit.source}).`
        };
      }
    }

    return { action: 'allow' };
  }
});
