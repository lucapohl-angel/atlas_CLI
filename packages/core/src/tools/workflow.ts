/**
 * Workflow tools — silent artefact generation for the slice-1 phase
 * router. None of these add slash commands; they're called by the
 * model during the discover/plan phases and are how the router's
 * file-existence signals get flipped.
 *
 * Tools:
 *   - context_note      append a Q+A or note to CONTEXT.draft.md
 *   - context_show      read whichever context file currently exists
 *   - context_finalize  promote the draft to CONTEXT.md (advances phase)
 *   - plan_write        emit/overwrite PLAN.xml from a structured input
 *   - plan_show         read + parse the current plan
 *   - plan_check        validate a plan input without writing it
 *
 * All tools require an active task in the cwd. They use loadActiveTask
 * (not the in-memory pointer) so they remain correct even when called
 * from a delegate child agent that doesn't share React state.
 */
import { z } from 'zod';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import {
  appendContextEntry,
  finalizeContext,
  readContext
} from '../workflow/context.js';
import { executePlan } from '../workflow/executor.js';
import {
  checkPlan,
  parsePlan,
  readPlan,
  serializePlan,
  writePlan,
  type Plan,
  type PlanTask
} from '../workflow/plan.js';
import { loadActiveTask } from '../workflow/state.js';
import type { TaskState } from '../workflow/types.js';
import type { Tool, ToolContext, ToolOk } from './types.js';

const requireActiveTask = async (
  ctx: ToolContext
): Promise<Result<TaskState, AtlasError>> => {
  const r = await loadActiveTask(ctx.cwd);
  if (!r.ok) return r;
  if (r.value === null) {
    return err(
      atlasError(
        'WORKFLOW_TASK_NOT_FOUND',
        'no active task in this workspace — workflow tools require a task started by the router'
      )
    );
  }
  return ok(r.value);
};

/* ------------------------------------------------------------------ */
/* context_note                                                       */
/* ------------------------------------------------------------------ */

const ContextNoteInput = z.object({
  heading: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  category: z.string().min(1).max(40).optional()
});

export const contextNoteTool: Tool<z.infer<typeof ContextNoteInput>> = {
  name: 'context_note',
  description: 'Append a Q+A pair, decision, or free-form note to CONTEXT.draft.md for the current task.',
  approval: 'auto',
  schema: ContextNoteInput,
  whenToUse:
    'Use during the discover phase to record clarifying questions and their answers, decisions you and the user reached, or constraints the user surfaced. The accumulated draft becomes CONTEXT.md after context_finalize.',
  outputContract: 'On success, summary is "context: +<heading>".',
  async execute(input, ctx) {
    const t = await requireActiveTask(ctx);
    if (!t.ok) return t;
    const r = await appendContextEntry(t.value, input);
    if (!r.ok) return r;
    const summary = `context: +${input.heading.slice(0, 80)}`;
    return ok({ type: 'ok', summary } satisfies ToolOk);
  }
};

/* ------------------------------------------------------------------ */
/* context_show                                                       */
/* ------------------------------------------------------------------ */

const ContextShowInput = z.object({});

export const contextShowTool: Tool<z.infer<typeof ContextShowInput>> = {
  name: 'context_show',
  description: 'Read the current CONTEXT.md (or its draft) for this task.',
  approval: 'auto',
  schema: ContextShowInput,
  whenToUse: 'Use to refresh your memory of what the user has already told you about the task.',
  outputContract: 'On success, summary is the file contents (truncated at 4000 chars).',
  async execute(_input, ctx) {
    const t = await requireActiveTask(ctx);
    if (!t.ok) return t;
    const r = await readContext(t.value);
    if (!r.ok) return r;
    if (r.value === null) {
      return ok({ type: 'ok', summary: '(no context yet)' } satisfies ToolOk);
    }
    const body = r.value.length > 4000 ? r.value.slice(0, 4000) + '\n…[truncated]' : r.value;
    return ok({ type: 'ok', summary: body } satisfies ToolOk);
  }
};

/* ------------------------------------------------------------------ */
/* context_finalize                                                   */
/* ------------------------------------------------------------------ */

const ContextFinalizeInput = z.object({
  summary: z.string().min(1).max(2000).optional()
});

export const contextFinalizeTool: Tool<z.infer<typeof ContextFinalizeInput>> = {
  name: 'context_finalize',
  description: 'Promote CONTEXT.draft.md to CONTEXT.md. Signals to the router that discover is done.',
  approval: 'auto',
  schema: ContextFinalizeInput,
  whenToUse:
    'Call this exactly once per task, when you and the user have agreed on enough context that you can write a plan with no remaining gray-area decisions. Add an optional 1–3 sentence summary of the agreed scope.',
  outputContract: 'On success, summary is "context: finalized at <path>".',
  async execute(input, ctx) {
    const t = await requireActiveTask(ctx);
    if (!t.ok) return t;
    const r = await finalizeContext(t.value, input.summary);
    if (!r.ok) return r;
    return ok({ type: 'ok', summary: `context: finalized at ${r.value.path}` } satisfies ToolOk);
  }
};

/* ------------------------------------------------------------------ */
/* plan_write                                                         */
/* ------------------------------------------------------------------ */

const PlanTaskInput = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  files: z.array(z.string().min(1).max(500)).min(1),
  action: z.string().min(1).max(4000),
  verify: z.string().min(1).max(1000),
  done: z.string().min(1).max(1000),
  deps: z.array(z.string().min(1).max(40)).optional()
});

const PlanWriteInput = z.object({
  tasks: z.array(PlanTaskInput).min(1).max(100)
});

const toPlan = (input: z.infer<typeof PlanWriteInput>): Plan => ({
  version: 1,
  tasks: input.tasks.map(
    (t): PlanTask => ({
      id: t.id,
      name: t.name,
      files: t.files,
      action: t.action,
      verify: t.verify,
      done: t.done,
      deps: t.deps ?? []
    })
  )
});

export const planWriteTool: Tool<z.infer<typeof PlanWriteInput>> = {
  name: 'plan_write',
  description: 'Emit PLAN.xml for the current task. Validates structure (unique ids, no cycles) before writing.',
  approval: 'auto',
  schema: PlanWriteInput,
  whenToUse:
    'Use during the plan phase, after CONTEXT.md is finalized. Decompose the work into ordered, independently-verifiable tasks. Each task must list the files it touches, a one-line action, a shell command that proves it works, and an explicit done criterion. Use `deps` (referencing other task ids in this same plan) when ordering matters.',
  outputContract: 'On success, summary is "plan: <n> tasks at <path>".',
  blockedOps: [
    'duplicate task ids (rejected by validator)',
    'unknown deps (rejected by validator)',
    'circular deps (rejected by validator)'
  ],
  examples: [
    {
      input:
        '{"tasks":[{"id":"01","name":"add hash","files":["src/auth/hash.ts"],"action":"implement bcrypt hash + verify","verify":"pnpm test src/auth/hash.test.ts","done":"hash + verify exported and tested"}]}',
      result: 'writes PLAN.xml with one task'
    }
  ],
  async execute(input, ctx) {
    const t = await requireActiveTask(ctx);
    if (!t.ok) return t;
    const plan = toPlan(input);
    const r = await writePlan(t.value, plan);
    if (!r.ok) return r;
    return ok({
      type: 'ok',
      summary: `plan: ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'} at ${r.value.path}`,
      data: { path: r.value.path, taskCount: plan.tasks.length }
    } satisfies ToolOk);
  }
};

/* ------------------------------------------------------------------ */
/* plan_show                                                          */
/* ------------------------------------------------------------------ */

const PlanShowInput = z.object({});

export const planShowTool: Tool<z.infer<typeof PlanShowInput>> = {
  name: 'plan_show',
  description: 'Read the current PLAN.xml and return a compact summary of its tasks.',
  approval: 'auto',
  schema: PlanShowInput,
  outputContract:
    'On success, summary is a numbered list "id name [n files] (deps: ...)" — one task per line.',
  async execute(_input, ctx) {
    const t = await requireActiveTask(ctx);
    if (!t.ok) return t;
    const r = await readPlan(t.value);
    if (!r.ok) return r;
    if (r.value === null) {
      return ok({ type: 'ok', summary: '(no plan yet)' } satisfies ToolOk);
    }
    const lines = r.value.tasks.map((task) => {
      const deps = task.deps.length > 0 ? ` (deps: ${task.deps.join(',')})` : '';
      return `${task.id} ${task.name} [${task.files.length} file${task.files.length === 1 ? '' : 's'}]${deps}`;
    });
    return ok({ type: 'ok', summary: lines.join('\n') } satisfies ToolOk);
  }
};

/* ------------------------------------------------------------------ */
/* plan_check                                                         */
/* ------------------------------------------------------------------ */

const PlanCheckInput = z.object({
  /** Optional XML string to validate. When omitted, validates the on-disk PLAN.xml. */
  xml: z.string().optional()
});

export const planCheckTool: Tool<z.infer<typeof PlanCheckInput>> = {
  name: 'plan_check',
  description: 'Validate a plan (parse + structural checks) without writing it.',
  approval: 'auto',
  schema: PlanCheckInput,
  whenToUse:
    'Use this to dry-run a plan before plan_write, or to re-check the on-disk PLAN.xml. The plan-checker agent loop calls this between planner re-prompts.',
  outputContract:
    'On success, summary is "ok: <n> tasks" or "issues: ..." with a semicolon-separated list.',
  async execute(input, ctx) {
    let xml: string | null = null;
    if (input.xml) {
      xml = input.xml;
    } else {
      const t = await requireActiveTask(ctx);
      if (!t.ok) return t;
      const r = await readPlan(t.value);
      if (!r.ok) return r;
      if (r.value === null) {
        return ok({ type: 'ok', summary: 'issues: no plan to check' } satisfies ToolOk);
      }
      // round-trip via serialize so the validator runs on the same bytes the writer would produce
      xml = serializePlan(r.value);
    }
    const parsed = parsePlan(xml);
    if (!parsed.ok) {
      return ok({ type: 'ok', summary: `issues: parse: ${parsed.error.message}` } satisfies ToolOk);
    }
    const issues = checkPlan(parsed.value);
    if (issues.length === 0) {
      return ok({ type: 'ok', summary: `ok: ${parsed.value.tasks.length} tasks` } satisfies ToolOk);
    }
    const detail = issues.map((i) => `[${i.taskId}] ${i.message}`).join('; ');
    return ok({ type: 'ok', summary: `issues: ${detail}` } satisfies ToolOk);
  }
};

/* ------------------------------------------------------------------ */
/* plan_execute                                                       */
/* ------------------------------------------------------------------ */

const PlanExecuteInput = z.object({
  maxConcurrent: z.number().int().min(1).max(8).optional(),
  cleanupWorktrees: z.boolean().optional(),
  base: z.string().optional(),
  maxVerifyRetries: z.number().int().min(0).max(5).optional()
});

export const planExecuteTool: Tool<z.infer<typeof PlanExecuteInput>> = {
  name: 'plan_execute',
  description:
    'Execute the on-disk PLAN.xml wave by wave: each task runs in its own git worktree, then verify, then commit.',
  approval: 'ask',
  schema: PlanExecuteInput,
  whenToUse:
    'Call exactly once at the start of the execute phase, after PLAN.xml has been written and validated. Re-running is allowed but will create new worktrees only for tasks that don\'t already have one.',
  outputContract:
    'On success, summary lists per-task outcomes "id stage ok|FAIL: msg". data carries {allOk, outcomes: [...]}.',
  blockedOps: [
    'running without a host-wired executePlanRun (returns TOOL_EXECUTION_FAILED)',
    'running outside a git repository (worktree creation will fail)',
    'running with no PLAN.xml on disk'
  ],
  async execute(input, ctx) {
    if (ctx.signal?.aborted) return err(atlasError('TOOL_CANCELLED', 'plan_execute cancelled'));
    const t = await requireActiveTask(ctx);
    if (!t.ok) return t;
    const runner = ctx.executePlanRun;
    if (!runner) {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          'plan_execute is not initialized: host did not wire executePlanRun. Wire createDelegateRunner per worktree.'
        )
      );
    }
    const r = await executePlan({
      state: t.value,
      run: runner,
      ...(input.maxConcurrent !== undefined ? { maxConcurrent: input.maxConcurrent } : {}),
      ...(input.cleanupWorktrees !== undefined ? { cleanupWorktrees: input.cleanupWorktrees } : {}),
      ...(input.base !== undefined ? { base: input.base } : {}),
      ...(input.maxVerifyRetries !== undefined
        ? { maxVerifyRetries: input.maxVerifyRetries }
        : { maxVerifyRetries: 2 }),
      ...(ctx.signal ? { signal: ctx.signal } : {})
    });
    if (!r.ok) return r;
    const lines = r.value.outcomes.map((o) => {
      const head = `${o.id} ${o.stage} ${o.ok ? 'ok' : 'FAIL'}`;
      const sha = o.commitSha ? ` ${o.commitSha.slice(0, 7)}` : '';
      const why = o.ok ? '' : `: ${o.error ?? o.summary.split('\n')[0] ?? 'unknown'}`;
      return `${head}${sha}${why}`;
    });
    const head = r.value.allOk
      ? `plan_execute: all ${r.value.outcomes.length} tasks committed`
      : `plan_execute: FAILED (${r.value.outcomes.filter((o) => o.ok).length}/${r.value.outcomes.length} ok)`;
    return ok({
      type: 'ok',
      summary: `${head}\n${lines.join('\n')}`,
      data: { allOk: r.value.allOk, outcomes: r.value.outcomes }
    } satisfies ToolOk);
  }
};

/* ------------------------------------------------------------------ */
/* ship_summary                                                       */
/* ------------------------------------------------------------------ */

interface GitRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runGit = async (
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal
): Promise<GitRunResult> => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolveP) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(signal ? { signal } : {})
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (e) => resolveP({ code: 1, stdout: '', stderr: String(e) }));
    child.on('close', (code) => resolveP({ code: code ?? 0, stdout, stderr }));
  });
};

const listShipBranches = async (
  ids: readonly string[],
  cwd: string,
  signal?: AbortSignal
): Promise<{ branches: readonly string[]; baseGuess: string }> => {
  const branchesRaw = await runGit(['branch', '--list', 'atlas/*'], cwd, signal);
  const allAtlasBranches = branchesRaw.stdout
    .split('\n')
    .map((s) => s.replace(/^[*\s]+/, '').trim())
    .filter(Boolean);
  const branches = ids.flatMap((id) =>
    allAtlasBranches.filter((b) => b.startsWith(`atlas/${id}`))
  );
  const baseGuess =
    (await runGit(['symbolic-ref', '--short', 'HEAD'], cwd, signal)).stdout.trim() || 'main';
  return { branches, baseGuess };
};

const ShipSummaryInput = z.object({});

export const shipSummaryTool: Tool<z.infer<typeof ShipSummaryInput>> = {
  name: 'ship_summary',
  description:
    'List the worktree branches produced during execute and ask the user which ship mode to use (auto/review/manual). Read-only.',
  approval: 'auto',
  schema: ShipSummaryInput,
  whenToUse:
    'Call exactly once at the start of the ship phase, then ask the user which mode they want: auto-merge, AI review, or manual (just show commands). Their choice drives a follow-up ship_apply call.',
  outputContract:
    'On success, summary lists each branch with last-commit subject and ends with a "pick a mode" prompt. data.branches and data.baseGuess feed ship_apply.',
  async execute(_input, ctx) {
    const t = await requireActiveTask(ctx);
    if (!t.ok) return t;
    const ids = t.value.worktreeIds ?? [];
    if (ids.length === 0) {
      return ok({
        type: 'ok',
        summary: 'ship: no worktrees recorded — nothing to ship'
      } satisfies ToolOk);
    }
    const { branches, baseGuess } = await listShipBranches(ids, ctx.cwd, ctx.signal);
    if (branches.length === 0) {
      return ok({
        type: 'ok',
        summary: `ship: ${ids.length} task(s) recorded but no atlas/* branches found in repo (already merged or worktrees removed?)`
      } satisfies ToolOk);
    }
    const lines: string[] = [
      `ship: ${branches.length} branch${branches.length === 1 ? '' : 'es'} ready (base: ${baseGuess})`
    ];
    for (const branch of branches) {
      const last = await runGit(['log', '-1', '--pretty=%h %s', branch], ctx.cwd, ctx.signal);
      const subject = last.stdout.trim() || '(no commits)';
      lines.push(`  ${branch} — ${subject}`);
    }
    lines.push('');
    lines.push('How do you want to ship? Pick one:');
    lines.push('  [a] auto    — merge every branch into ' + baseGuess + ' (--no-ff). Aborts on conflict.');
    lines.push('  [r] review  — read each diff and surface bugs/risks before you decide.');
    lines.push('  [m] manual  — just print git/gh commands; you run them.');
    return ok({
      type: 'ok',
      summary: lines.join('\n'),
      data: { branches, baseGuess }
    } satisfies ToolOk);
  }
};

/* ------------------------------------------------------------------ */
/* ship_apply                                                         */
/* ------------------------------------------------------------------ */

const ShipApplyInput = z.object({
  mode: z.enum(['auto', 'review', 'manual']),
  base: z.string().optional(),
  branches: z.array(z.string()).optional()
});

const truncateDiff = (s: string, limit = 4000): string =>
  s.length <= limit ? s : `${s.slice(0, limit)}\n… [+${s.length - limit} bytes truncated]`;

export const shipApplyTool: Tool<z.infer<typeof ShipApplyInput>> = {
  name: 'ship_apply',
  description:
    'Apply a ship mode to the active task branches. mode=auto merges them into base, mode=review returns per-branch diffs for the model to analyze, mode=manual prints paste-ready commands.',
  approval: 'ask',
  schema: ShipApplyInput,
  whenToUse:
    'Call after ship_summary once the user has picked a mode. Pass mode=auto|review|manual; optionally restrict to a subset of branches.',
  outputContract:
    'mode=manual: same git/gh commands as ship_summary. mode=review: one diff block per branch (truncated to 4kB) for the model to summarize. mode=auto: per-branch merge result; on conflict the merge is aborted and the tool stops.',
  blockedOps: [
    'auto-merge while you have uncommitted changes on base (refuses)',
    'pushing to remote (never — user does that)',
    'opening PRs (never — user runs `gh pr create`)'
  ],
  async execute(input, ctx) {
    const t = await requireActiveTask(ctx);
    if (!t.ok) return t;
    const ids = t.value.worktreeIds ?? [];
    if (ids.length === 0) {
      return ok({ type: 'ok', summary: 'ship_apply: no worktrees recorded' } satisfies ToolOk);
    }
    const { branches: discovered, baseGuess } = await listShipBranches(ids, ctx.cwd, ctx.signal);
    const base = input.base ?? baseGuess;
    const branches = input.branches && input.branches.length > 0 ? input.branches : discovered;
    if (branches.length === 0) {
      return ok({ type: 'ok', summary: 'ship_apply: no atlas/* branches to ship' } satisfies ToolOk);
    }

    if (input.mode === 'manual') {
      const lines: string[] = [`ship_apply manual (base: ${base}):`];
      for (const branch of branches) {
        lines.push(`  git merge --no-ff ${branch}`);
        lines.push(`  gh pr create --base ${base} --head ${branch} --fill`);
      }
      lines.push('');
      lines.push(`Combined: git checkout ${base} && git merge --no-ff ${branches.join(' ')}`);
      return ok({ type: 'ok', summary: lines.join('\n'), data: { branches, base } } satisfies ToolOk);
    }

    if (input.mode === 'review') {
      const lines: string[] = [`ship_apply review (base: ${base}, ${branches.length} branch(es)):`];
      for (const branch of branches) {
        const stat = await runGit(['diff', '--stat', `${base}...${branch}`], ctx.cwd, ctx.signal);
        const diff = await runGit(['diff', `${base}...${branch}`], ctx.cwd, ctx.signal);
        lines.push('');
        lines.push(`=== ${branch} ===`);
        lines.push(stat.stdout.trim() || '(no diff)');
        if (diff.stdout.trim().length > 0) {
          lines.push('--- diff ---');
          lines.push(truncateDiff(diff.stdout));
        }
      }
      lines.push('');
      lines.push(
        'Review the diffs above and report any bugs, security risks, or concerns per branch. ' +
          'Then ask the user whether to proceed with auto-merge, drop a branch, or switch to manual.'
      );
      return ok({ type: 'ok', summary: lines.join('\n'), data: { branches, base } } satisfies ToolOk);
    }

    // mode === 'auto'
    const status = await runGit(
      ['status', '--porcelain', '--untracked-files=no'],
      ctx.cwd,
      ctx.signal
    );
    if (status.stdout.trim().length > 0) {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          'auto-merge refused: working tree has uncommitted changes. Commit or stash, then retry.'
        )
      );
    }
    const checkout = await runGit(['checkout', base], ctx.cwd, ctx.signal);
    if (checkout.code !== 0) {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          `auto-merge: failed to checkout ${base}: ${checkout.stderr.trim() || 'unknown'}`
        )
      );
    }
    const lines: string[] = [`ship_apply auto (base: ${base}):`];
    const merged: string[] = [];
    for (const branch of branches) {
      const merge = await runGit(
        ['merge', '--no-ff', '-m', `merge ${branch}`, branch],
        ctx.cwd,
        ctx.signal
      );
      if (merge.code === 0) {
        merged.push(branch);
        lines.push(`  ✓ merged ${branch}`);
        continue;
      }
      // Conflict — abort and stop.
      await runGit(['merge', '--abort'], ctx.cwd, ctx.signal);
      lines.push(`  ✗ ${branch}: merge conflict — aborted`);
      lines.push(`    stderr: ${merge.stderr.trim().split('\n').slice(0, 5).join(' | ')}`);
      lines.push('');
      lines.push(
        `Merged ${merged.length}/${branches.length} before stopping. Resolve ${branch} manually:`
      );
      lines.push(`  git merge --no-ff ${branch}`);
      lines.push('  # fix conflicts, then: git commit');
      return ok({
        type: 'ok',
        summary: lines.join('\n'),
        data: { merged, failedAt: branch, base }
      } satisfies ToolOk);
    }
    lines.push('');
    lines.push(`All ${merged.length} branch(es) merged into ${base}. Push when ready: git push`);
    return ok({
      type: 'ok',
      summary: lines.join('\n'),
      data: { merged, base }
    } satisfies ToolOk);
  }
};

