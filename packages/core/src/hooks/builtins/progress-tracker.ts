/**
 * Progress-tracker hook (Six-File Context System).
 *
 * Fires `afterTool` on the `terminal` tool. When the executed command
 * was a successful `git commit`, appends a one-line entry to
 * `context/progress-tracker.md` under the "## Recent Decisions"
 * heading: `[shortsha] commit subject`.
 *
 * Best-effort:
 *  - Silently no-ops when the tracker file doesn't exist (no pack).
 *  - Silently no-ops when the command wasn't a commit, when the
 *    commit failed, or when `git log` can't be probed.
 *  - Never throws — hooks must never break the loop.
 *
 * The hook returns `{ action: 'allow' }` so it never blocks tool
 * execution. The append is purely a side effect.
 */
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HookSpec } from '../types.js';

const TRACKER_REL = 'context/progress-tracker.md';
const HEADING = '## Recent Decisions';

const isGitCommitCommand = (input: unknown): boolean => {
  if (!input || typeof input !== 'object') return false;
  const cmd = (input as { command?: unknown }).command;
  if (typeof cmd !== 'string') return false;
  const trimmed = cmd.trim();
  // Accept `git commit ...`, `git -c ... commit`, etc. Reject
  // `git --no-pager log` and friends.
  return /^git(\s+-[A-Za-z0-9-]+(\s+\S+)?)*\s+commit\b/.test(trimmed);
};

const probeLatestCommit = (
  cwd: string,
  signal: AbortSignal | undefined
): Promise<{ sha: string; subject: string } | undefined> =>
  new Promise((resolve) => {
    const child = spawn('git', ['log', '-1', '--format=%h%x09%s'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let out = '';
    let settled = false;
    const settle = (v: { sha: string; subject: string } | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.on('error', () => settle(undefined));
    child.on('close', (code) => {
      if (code !== 0) return settle(undefined);
      const line = out.split('\n')[0]?.trim() ?? '';
      const tab = line.indexOf('\t');
      if (tab <= 0) return settle(undefined);
      const sha = line.slice(0, tab);
      const subject = line.slice(tab + 1).trim();
      if (!sha || !subject) return settle(undefined);
      settle({ sha, subject });
    });
    if (signal) {
      const onAbort = (): void => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        settle(undefined);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });

const appendUnderHeading = (existing: string, line: string): string => {
  const idx = existing.indexOf(HEADING);
  if (idx < 0) return existing;
  // Insert immediately after the heading line. Skip the heading line
  // itself plus an optional intro/quote line ("> Append newest at...").
  const afterHeading = existing.indexOf('\n', idx);
  if (afterHeading < 0) return existing;
  // Find the first blank-line-then-content; we insert at the start of
  // the first list-content section so newest stays at the top.
  let insertAt = afterHeading + 1;
  // Skip leading blockquote / blank lines that often follow the heading.
  while (insertAt < existing.length) {
    const eol = existing.indexOf('\n', insertAt);
    const lineSlice = existing.slice(insertAt, eol < 0 ? existing.length : eol);
    if (lineSlice.startsWith('> ') || lineSlice.trim() === '') {
      insertAt = (eol < 0 ? existing.length : eol) + 1;
      continue;
    }
    break;
  }
  return `${existing.slice(0, insertAt)}- ${line}\n${existing.slice(insertAt)}`;
};

const escapeForRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const alreadyLogged = (existing: string, sha: string): boolean =>
  new RegExp(`\\[${escapeForRegex(sha)}\\]`).test(existing);

export const progressTrackerHook = (cwd: string): HookSpec<'afterTool'> => ({
  event: 'afterTool',
  matcher: 'terminal',
  async handler(ctx) {
    try {
      // Only act on successful tool runs.
      if (ctx.result.type !== 'ok') return { action: 'allow' };
      if (!isGitCommitCommand(ctx.input)) return { action: 'allow' };

      const trackerAbs = join(cwd, TRACKER_REL);
      try {
        const s = await stat(trackerAbs);
        if (!s.isFile()) return { action: 'allow' };
      } catch {
        return { action: 'allow' };
      }

      const latest = await probeLatestCommit(cwd, ctx.signal);
      if (!latest) return { action: 'allow' };

      const existing = await readFile(trackerAbs, 'utf8');
      if (alreadyLogged(existing, latest.sha)) return { action: 'allow' };

      const line = `\`[${latest.sha}]\` ${latest.subject}`;
      const next = appendUnderHeading(existing, line);
      if (next === existing) return { action: 'allow' }; // no heading found
      await writeFile(trackerAbs, next, 'utf8');
    } catch {
      // Hooks never throw.
    }
    return { action: 'allow' };
  }
});
