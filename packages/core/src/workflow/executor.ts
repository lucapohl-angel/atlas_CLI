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

const log = childLogger('executor');

export interface RunTaskRequest {
  readonly task: PlanTask;
  readonly worktree: WorktreeHandle;
  readonly signal?: AbortSignal;
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
        error: 'cancelled'
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
        error: wt.error.message
      }
    };
  }
  const worktree = wt.value;

  const agentResult = await opts.run({
    task,
    worktree,
    ...(opts.signal ? { signal: opts.signal } : {})
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
        worktreePath: worktree.path
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
        worktreePath: worktree.path
      },
      worktreeId: worktree.id
    };
  }
  if (v.value.code !== 0) {
    return {
      outcome: {
        id: task.id,
        name: task.name,
        stage: 'verify',
        ok: false,
        summary: `verify exit ${v.value.code}\nstdout:\n${truncate(v.value.stdout)}\nstderr:\n${truncate(v.value.stderr)}`,
        error: `verify failed (exit ${v.value.code})`,
        worktreePath: worktree.path
      },
      worktreeId: worktree.id
    };
  }

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
        worktreePath: worktree.path
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
        ? `done (${commit.value.sha?.slice(0, 7) ?? 'committed'})`
        : 'done (no changes to commit)',
      worktreePath: worktree.path,
      ...(commit.value.sha ? { commitSha: commit.value.sha } : {})
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
