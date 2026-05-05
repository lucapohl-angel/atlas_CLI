/**
 * Wave-by-wave plan executor for the slice-3 phase pipeline.
 *
 * Responsibilities:
 *   1. Group plan tasks into dependency waves
 *   2. For each wave: spin up one git worktree per task and dispatch
 *      a child agent (via the host-supplied RunTaskFn) into it
 *   3. Run the task's <verify> shell command in its worktree
 *   4. On verify success, atomic commit with `feat(<id>): <name>`
 *   5. After all waves complete, mark the TaskState's allTasksCommitted
 *      / allVerifyPassed flags so the slice-1 router can advance to ship
 *
 * The executor is deliberately injection-driven: it knows nothing
 * about providers, agents, or LLMs. The host wires a RunTaskFn (the
 * CLI uses createDelegateRunner under the hood) and we test the
 * orchestration with a mocked RunTaskFn.
 */
import { spawn } from 'node:child_process';
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import { err, ok, type Result } from '../result.js';
import type { PlanTask } from './plan.js';
import { readPlan } from './plan.js';
import { updateTask } from './state.js';
import type { TaskState } from './types.js';
import { groupIntoWaves } from './waves.js';
import { commitWorktree, createWorktree, removeWorktree, type WorktreeHandle } from './worktree.js';
import type { ApprovalPolicy } from '../tools/types.js';

const log = childLogger('executor');

export interface RunTaskRequest {
  readonly task: PlanTask;
  readonly worktree: WorktreeHandle;
  readonly signal?: AbortSignal;
  /** Approval policy inherited from the plan_execute tool call. */
  readonly approve?: ApprovalPolicy;
}

export interface RunTaskOutcome {
  readonly ok: boolean;
  readonly summary: string;
  readonly error?: string;
}

export type RunTaskFn = (req: RunTaskRequest) => Promise<RunTaskOutcome>;

export interface ExecutorOpts {
  readonly state: TaskState;
  readonly run: RunTaskFn;
  readonly maxConcurrent?: number;
  readonly signal?: AbortSignal;
  readonly base?: string;
  /** Override for tests / non-default repo roots (defaults to state.cwd). */
  readonly repoRoot?: string;
  /** When true, removes per-task worktrees after completion (default: keep). */
  readonly cleanupWorktrees?: boolean;
  /**
   * Slice-3 verify loop: when a task's <verify> exits non-zero, the
   * executor re-dispatches the same RunTaskFn up to this many times
   * with a debugger-flavored goal that includes the failing verify
   * output. Each retry runs verify again. Default 0 (no retry).
   */
  readonly maxVerifyRetries?: number;
  /** Approval policy inherited from the plan_execute tool call. */
  readonly approve?: ApprovalPolicy;
}

export interface TaskOutcome {
  readonly id: string;
  readonly name: string;
  readonly stage: 'agent' | 'verify' | 'commit' | 'done';
  readonly ok: boolean;
  readonly summary: string;
  readonly error?: string;
  readonly worktreePath?: string;
  readonly commitSha?: string;
  /** Number of agent dispatches (1 = first try, >1 = verify retries). */
  readonly attempts?: number;
}

export interface ExecutionReport {
  readonly outcomes: readonly TaskOutcome[];
  readonly allOk: boolean;
}

interface VerifyResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runVerify = async (
  cwd: string,
  cmd: string,
  signal?: AbortSignal
): Promise<Result<VerifyResult, AtlasError>> => {
  return new Promise((resolveP) => {
    const child = spawn('sh', ['-c', cmd], {
      cwd,
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
    if (signal) {
      if (signal.aborted) child.kill('SIGTERM');
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      resolveP(
        err(atlasError('TOOL_EXECUTION_FAILED', `verify spawn failed: ${e.message}`, { cause: e }))
      );
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolveP(ok({ code: code ?? 0, stdout, stderr }));
    });
  });
};

const truncate = (s: string, max = 1500): string =>
  s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;

const runWithConcurrency = async <T, R>(
  items: readonly T[],
  fn: (item: T, idx: number) => Promise<R>,
  limit: number
): Promise<readonly R[]> => {
  const out: R[] = new Array(items.length) as R[];
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      const itm = items[idx];
      if (itm === undefined) return;
      out[idx] = await fn(itm, idx);
    }
  });
  await Promise.all(workers);
  return out;
};

const debuggerGoal = (
  task: PlanTask,
  attempt: number,
  prevStdout: string,
  prevStderr: string
): string =>
  `RETRY ${attempt}: the previous attempt at task ${task.id} (${task.name}) ` +
  `failed its verify command.\n\n` +
  `Verify command:\n${task.verify}\n\n` +
  `Failing stdout:\n${truncate(prevStdout)}\n\n` +
  `Failing stderr:\n${truncate(prevStderr)}\n\n` +
  `Diagnose what's wrong, fix it in this worktree, then stop. The verify ` +
  `command will be re-run automatically — do not run it yourself.\n\n` +
  `Original action:\n${task.action}\n\n` +
  `Done criterion:\n${task.done}`;

const runOneTask = async (
  task: PlanTask,
  opts: ExecutorOpts,
  repoRoot: string
): Promise<{ outcome: TaskOutcome; worktreeId?: string }> => {
  if (opts.signal?.aborted) {
    return {
      outcome: {
        id: task.id,
        name: task.name,
        stage: 'agent',
        ok: false,
        summary: 'cancelled before agent dispatch',
        error: 'cancelled',
        attempts: 0
      }
    };
  }

  const wt = await createWorktree({
    repoRoot,
    id: task.id,
    slug: task.name,
    ...(opts.base ? { base: opts.base } : {}),
    ...(opts.signal ? { signal: opts.signal } : {})
  });
  if (!wt.ok) {
    return {
      outcome: {
        id: task.id,
        name: task.name,
        stage: 'agent',
        ok: false,
        summary: `worktree creation failed: ${wt.error.message}`,
        error: wt.error.message,
        attempts: 0
      }
    };
  }
  const worktree = wt.value;
  const maxRetries = opts.maxVerifyRetries ?? 0;
  let attempts = 0;
  let lastVerifyStdout = '';
  let lastVerifyStderr = '';
  let lastVerifyExit = 0;

  // Initial agent dispatch + verify, then up to maxRetries debugger
  // re-dispatches if verify keeps failing.
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (opts.signal?.aborted) break;
    attempts += 1;
    const agentResult =
      attempt === 0
        ? await opts.run({
            task,
            worktree,
            ...(opts.signal ? { signal: opts.signal } : {}),
            ...(opts.approve ? { approve: opts.approve } : {})
          })
        : await opts.run({
            task: { ...task, action: debuggerGoal(task, attempt, lastVerifyStdout, lastVerifyStderr) },
            worktree,
            ...(opts.signal ? { signal: opts.signal } : {}),
            ...(opts.approve ? { approve: opts.approve } : {})
          });

    if (!agentResult.ok) {
      return {
        outcome: {
          id: task.id,
          name: task.name,
          stage: 'agent',
          ok: false,
          summary: agentResult.summary,
          ...(agentResult.error ? { error: agentResult.error } : {}),
          worktreePath: worktree.path,
          attempts
        },
        worktreeId: worktree.id
      };
    }

    const v = await runVerify(worktree.path, task.verify, opts.signal);
    if (!v.ok) {
      return {
        outcome: {
          id: task.id,
          name: task.name,
          stage: 'verify',
          ok: false,
          summary: `verify could not run: ${v.error.message}`,
          error: v.error.message,
          worktreePath: worktree.path,
          attempts
        },
        worktreeId: worktree.id
      };
    }
    lastVerifyStdout = v.value.stdout;
    lastVerifyStderr = v.value.stderr;
    lastVerifyExit = v.value.code;
    if (v.value.code === 0) {
      const commit = await commitWorktree(
        worktree.path,
        `feat(${task.id}): ${task.name}`,
        opts.signal
      );
      if (!commit.ok) {
        return {
          outcome: {
            id: task.id,
            name: task.name,
            stage: 'commit',
            ok: false,
            summary: `commit failed: ${commit.error.message}`,
            error: commit.error.message,
            worktreePath: worktree.path,
            attempts
          },
          worktreeId: worktree.id
        };
      }
      return {
        outcome: {
          id: task.id,
          name: task.name,
          stage: 'done',
          ok: true,
          summary: commit.value.committed
            ? `done (${commit.value.sha?.slice(0, 7) ?? 'committed'}${attempts > 1 ? `, ${attempts} attempts` : ''})`
            : `done (no changes to commit${attempts > 1 ? `, ${attempts} attempts` : ''})`,
          worktreePath: worktree.path,
          ...(commit.value.sha ? { commitSha: commit.value.sha } : {}),
          attempts
        },
        worktreeId: worktree.id
      };
    }
    log.debug(
      { task: task.id, attempt: attempts, exit: v.value.code },
      'verify failed; retrying with debugger goal'
    );
  }

  return {
    outcome: {
      id: task.id,
      name: task.name,
      stage: 'verify',
      ok: false,
      summary: `verify exit ${lastVerifyExit} after ${attempts} attempt${attempts === 1 ? '' : 's'}\nstdout:\n${truncate(lastVerifyStdout)}\nstderr:\n${truncate(lastVerifyStderr)}`,
      error: `verify failed (exit ${lastVerifyExit}, ${attempts} attempts)`,
      worktreePath: worktree.path,
      attempts
    },
    worktreeId: worktree.id
  };
};

/**
 * Execute the on-disk PLAN.xml for the active task, wave by wave.
 * Each task runs in its own worktree, then verify, then commit.
 *
 * On all-success the TaskState's `allTasksCommitted` and
 * `allVerifyPassed` flags flip to true and the worktree-id list is
 * persisted, which lets the slice-1 router advance the phase to ship
 * on the next user message.
 */
export const executePlan = async (
  opts: ExecutorOpts
): Promise<Result<ExecutionReport, AtlasError>> => {
  const plan = await readPlan(opts.state);
  if (!plan.ok) return plan;
  if (plan.value === null) {
    return err(atlasError('WORKFLOW_TASK_NOT_FOUND', 'no PLAN.xml to execute'));
  }
  const waves = groupIntoWaves(plan.value);
  if (!waves.ok) return waves;

  const repoRoot = opts.repoRoot ?? opts.state.cwd;
  const concurrency = opts.maxConcurrent ?? 3;
  const allOutcomes: TaskOutcome[] = [];
  const worktreeIds: string[] = [...(opts.state.worktreeIds ?? [])];

  let aborted = false;
  for (const wave of waves.value) {
    if (opts.signal?.aborted || aborted) break;
    const results = await runWithConcurrency(
      wave,
      async (task) => runOneTask(task, opts, repoRoot),
      concurrency
    );
    for (const r of results) {
      allOutcomes.push(r.outcome);
      if (r.worktreeId && !worktreeIds.includes(r.worktreeId)) {
        worktreeIds.push(r.worktreeId);
      }
      if (!r.outcome.ok) aborted = true;
    }
    if (aborted) break;
  }

  // Optional cleanup of worktrees (default: keep so the user can inspect).
  if (opts.cleanupWorktrees) {
    for (const out of allOutcomes) {
      if (out.worktreePath) {
        const r = await removeWorktree(repoRoot, out.worktreePath, {
          ...(opts.signal ? { signal: opts.signal } : {})
        });
        if (!r.ok) log.debug({ id: out.id, err: r.error.message }, 'worktree cleanup failed');
      }
    }
  }

  const allOk = allOutcomes.length === plan.value.tasks.length && allOutcomes.every((o) => o.ok);

  await updateTask(opts.state, {
    worktreeIds,
    allTasksCommitted: allOk,
    allVerifyPassed: allOk
  });

  return ok({ outcomes: allOutcomes, allOk });
};

export const __test = { runVerify, runWithConcurrency };
