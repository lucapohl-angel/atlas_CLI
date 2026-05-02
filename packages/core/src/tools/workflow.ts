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

const ShipSummaryInput = z.object({});

export const shipSummaryTool: Tool<z.infer<typeof ShipSummaryInput>> = {
  name: 'ship_summary',
  description:
    'Summarize the worktree branches produced during execute, with paste-ready git/gh commands. Read-only.',
  approval: 'auto',
  schema: ShipSummaryInput,
  whenToUse:
    'Call once at the start of the ship phase. The user decides what to do with the branches — Atlas never auto-merges, auto-pushes, or opens PRs without an explicit ask.',
  outputContract:
    'On success, summary is "ship: <n> branches\\nbranch — last commit subject\\n  merge: git merge --no-ff <branch>\\n  pr: gh pr create --base <baseGuess> --head <branch>".',
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
    const { spawn } = await import('node:child_process');
    const runGit = (args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }> =>
      new Promise((resolveP) => {
        const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
        let stdout = '';
        child.stdout.on('data', (b: Buffer) => {
          stdout += b.toString('utf8');
        });
        child.on('error', () => resolveP({ code: 1, stdout: '' }));
        child.on('close', (code) => resolveP({ code: code ?? 0, stdout }));
      });
    const branchesRaw = await runGit(['branch', '--list', 'atlas/*'], ctx.cwd);
    const allAtlasBranches = branchesRaw.stdout
      .split('\n')
      .map((s) => s.replace(/^[*\s]+/, '').trim())
      .filter(Boolean);
    const matching = ids.flatMap((id) =>
      allAtlasBranches.filter((b) => b.startsWith(`atlas/${id}`))
    );
    if (matching.length === 0) {
      return ok({
        type: 'ok',
        summary: `ship: ${ids.length} task(s) recorded but no atlas/* branches found in repo (already merged or worktrees removed?)`
      } satisfies ToolOk);
    }
    const baseGuess = (await runGit(['symbolic-ref', '--short', 'HEAD'], ctx.cwd)).stdout.trim() || 'main';
    const lines: string[] = [`ship: ${matching.length} branch${matching.length === 1 ? '' : 'es'}`];
    for (const branch of matching) {
      const last = await runGit(['log', '-1', '--pretty=%h %s', branch], ctx.cwd);
      const subject = last.stdout.trim() || '(no commits)';
      lines.push(`${branch} — ${subject}`);
      lines.push(`  merge: git merge --no-ff ${branch}`);
      lines.push(`  pr:    gh pr create --base ${baseGuess} --head ${branch} --fill`);
    }
    return ok({
      type: 'ok',
      summary: lines.join('\n'),
      data: { branches: matching, baseGuess }
    } satisfies ToolOk);
  }
};
