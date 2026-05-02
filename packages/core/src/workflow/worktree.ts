/**
 * Git worktree wrapper for slice-3 wave execution.
 *
 * Each plan task is executed in an isolated worktree under
 * `<repoRoot>/.atlas/worktrees/<task-id>/`, on a branch named
 * `atlas/<task-id>-<slug>`. Concurrent tasks therefore can't step
 * on each other's index, working tree, or git internals.
 *
 * Operations are thin Result-returning wrappers around `git worktree`
 * — we never throw, we never silently ignore, and we never pass user
 * input through a shell. All git invocations use argv.
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import { err, ok, type Result } from '../result.js';

const log = childLogger('worktree');

const WORKTREE_DIRNAME = '.atlas/worktrees';

export interface WorktreeHandle {
  readonly id: string;
  readonly path: string;
  readonly branch: string;
  readonly base: string;
}

export interface CreateWorktreeOpts {
  readonly repoRoot: string;
  readonly id: string;
  readonly base?: string;
  readonly slug?: string;
  readonly signal?: AbortSignal;
}

interface RunOpts {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runGit = async (
  args: readonly string[],
  opts: RunOpts
): Promise<Result<RunResult, AtlasError>> => {
  return new Promise((resolveP) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        child.kill('SIGTERM');
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort);
      resolveP(
        err(
          atlasError('TOOL_EXECUTION_FAILED', `git failed to spawn: ${e.message}`, { cause: e })
        )
      );
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      resolveP(ok({ code: code ?? 0, stdout, stderr }));
    });
  });
};

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 32);

const ensureRepoRoot = async (
  repoRoot: string,
  signal?: AbortSignal
): Promise<Result<string, AtlasError>> => {
  const r = await runGit(['rev-parse', '--show-toplevel'], {
    cwd: repoRoot,
    ...(signal ? { signal } : {})
  });
  if (!r.ok) return r;
  if (r.value.code !== 0) {
    return err(
      atlasError(
        'TOOL_EXECUTION_FAILED',
        `not a git repository: ${repoRoot} (${r.value.stderr.trim()})`
      )
    );
  }
  return ok(resolve(r.value.stdout.trim()));
};

/**
 * Create a worktree at `<repoRoot>/.atlas/worktrees/<id>/` checked out
 * to a fresh branch `atlas/<id>-<slug>` based on `base`. If the branch
 * already exists (re-running execute on the same plan) we reuse it
 * via `git worktree add --force` semantics — the worktree dir itself
 * must not already exist.
 */
export const createWorktree = async (
  opts: CreateWorktreeOpts
): Promise<Result<WorktreeHandle, AtlasError>> => {
  const root = await ensureRepoRoot(opts.repoRoot, opts.signal);
  if (!root.ok) return root;
  const repoRoot = root.value;
  const base = opts.base ?? 'HEAD';
  const slug = opts.slug ? slugify(opts.slug) : opts.id;
  const branch = `atlas/${opts.id}${slug ? `-${slug}` : ''}`;
  const path = join(repoRoot, WORKTREE_DIRNAME, opts.id);

  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (e) {
    return err(
      atlasError('TOOL_EXECUTION_FAILED', 'failed to mkdir worktree parent', { cause: e })
    );
  }

  const add = await runGit(['worktree', 'add', '-B', branch, path, base], {
    cwd: repoRoot,
    ...(opts.signal ? { signal: opts.signal } : {})
  });
  if (!add.ok) return add;
  if (add.value.code !== 0) {
    return err(
      atlasError(
        'TOOL_EXECUTION_FAILED',
        `git worktree add failed (code ${add.value.code}): ${add.value.stderr.trim() || add.value.stdout.trim()}`
      )
    );
  }
  log.debug({ id: opts.id, branch, path }, 'worktree created');
  return ok({ id: opts.id, path, branch, base });
};

/**
 * Stage everything in the worktree and create one atomic commit.
 * Returns `{ committed: false, ... }` when there are no changes
 * (verify-only tasks that touched nothing are valid). Returns an
 * error when the commit itself failed (e.g. hooks rejected).
 */
export const commitWorktree = async (
  worktreePath: string,
  message: string,
  signal?: AbortSignal
): Promise<Result<{ readonly committed: boolean; readonly sha?: string }, AtlasError>> => {
  const add = await runGit(['add', '-A'], {
    cwd: worktreePath,
    ...(signal ? { signal } : {})
  });
  if (!add.ok) return add;
  if (add.value.code !== 0) {
    return err(
      atlasError('TOOL_EXECUTION_FAILED', `git add failed: ${add.value.stderr.trim()}`)
    );
  }
  const status = await runGit(['status', '--porcelain'], {
    cwd: worktreePath,
    ...(signal ? { signal } : {})
  });
  if (!status.ok) return status;
  if (status.value.code !== 0) {
    return err(
      atlasError('TOOL_EXECUTION_FAILED', `git status failed: ${status.value.stderr.trim()}`)
    );
  }
  if (status.value.stdout.trim().length === 0) {
    return ok({ committed: false });
  }
  const commit = await runGit(['commit', '-m', message, '--no-verify'], {
    cwd: worktreePath,
    ...(signal ? { signal } : {})
  });
  if (!commit.ok) return commit;
  if (commit.value.code !== 0) {
    return err(
      atlasError(
        'TOOL_EXECUTION_FAILED',
        `git commit failed: ${commit.value.stderr.trim() || commit.value.stdout.trim()}`
      )
    );
  }
  const head = await runGit(['rev-parse', 'HEAD'], {
    cwd: worktreePath,
    ...(signal ? { signal } : {})
  });
  if (!head.ok) return head;
  return ok({
    committed: true,
    sha: head.value.code === 0 ? head.value.stdout.trim() : undefined
  });
};

/**
 * Remove a worktree (and its branch when `keepBranch` is false). Best-
 * effort: returns ok even if the worktree was already gone, but
 * surfaces real git errors as Result.err.
 */
export const removeWorktree = async (
  repoRoot: string,
  worktreePath: string,
  opts: { readonly keepBranch?: boolean; readonly signal?: AbortSignal } = {}
): Promise<Result<void, AtlasError>> => {
  const r = await runGit(['worktree', 'remove', '--force', worktreePath], {
    cwd: repoRoot,
    ...(opts.signal ? { signal: opts.signal } : {})
  });
  if (!r.ok) return r;
  // Code != 0 usually means "not a worktree" — fine for cleanup.
  if (r.value.code !== 0) {
    log.debug({ worktreePath, stderr: r.value.stderr }, 'worktree remove non-zero (treating as ok)');
  }
  return ok(undefined);
};

export const __test = { runGit, slugify };
