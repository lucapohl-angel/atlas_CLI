/**
 * Workflow phase router — types.
 *
 * The phase router replaces explicit slash-command pipeline control with
 * a single implicit state machine the orchestrator advances on its own.
 * The user just talks; Atlas decides which phase the conversation is in.
 *
 * Phases are deliberately a small enum (six values) so the TUI can
 * surface the current phase as a single status chip and so transition
 * logic stays auditable.
 */
import { z } from 'zod';

/**
 * The six canonical phases of an Atlas task.
 *
 *   idle      → no active task; first non-trivial user message kicks
 *               off `discover`.
 *   discover  → clarifying questions accumulate into `CONTEXT.md`
 *               (slice 2). Exits when the gray-area set is empty.
 *   plan      → planner emits an XML plan with `<verify>`/`<done>`
 *               criteria (slice 2). Plan-checker loops until pass.
 *   execute   → wave-parallel execution in git worktrees (slice 3).
 *   verify    → run each task's `<verify>` command; on failure spawn a
 *               debugger sub-plan and loop back to `execute`.
 *   ship      → all verifies green; offer commit / PR (never forced).
 */
export type Phase = 'idle' | 'discover' | 'plan' | 'execute' | 'verify' | 'ship';

export const PHASES: readonly Phase[] = [
  'idle',
  'discover',
  'plan',
  'execute',
  'verify',
  'ship'
] as const;

/**
 * Persisted per-task state. Lives at
 * `<cwd>/.atlas/tasks/<id>/state.json`. The fields beyond
 * `id`/`title`/`phase`/`cwd`/`createdAt`/`updatedAt` are populated by
 * later slices and remain optional so slice 1 can ship without them.
 */
export interface TaskState {
  readonly id: string;
  readonly title: string;
  readonly phase: Phase;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Free-form one-line note shown in `/status` (e.g. "2 open questions"). */
  readonly note?: string;
  /** Path to CONTEXT.md (slice 2), relative to the task dir. */
  readonly contextDocPath?: string;
  /** Path to PLAN.xml (slice 2), relative to the task dir. */
  readonly planDocPath?: string;
  /** Worktree task ids spawned during execute (slice 3). */
  readonly worktreeIds?: readonly string[];
  /** Slice 3: set true once every plan task committed in its worktree. */
  readonly allTasksCommitted?: boolean;
  /** Slice 3: set true once every <verify> command exited 0. */
  readonly allVerifyPassed?: boolean;
}

/**
 * Schema for on-disk task state. Used by `loadTaskState` to validate
 * before returning. New optional fields can be added without
 * invalidating existing files because `.passthrough()` is intentionally
 * not used — unknown fields are dropped on next save, keeping the
 * shape canonical.
 */
export const TaskStateSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  phase: z.enum(['idle', 'discover', 'plan', 'execute', 'verify', 'ship']),
  cwd: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  note: z.string().optional(),
  contextDocPath: z.string().optional(),
  planDocPath: z.string().optional(),
  worktreeIds: z.array(z.string()).optional(),
  allTasksCommitted: z.boolean().optional(),
  allVerifyPassed: z.boolean().optional()
});

/**
 * Pointer file at `<cwd>/.atlas/tasks/current.json`. Tracks which
 * task id is currently active for this working directory. A null
 * `activeTaskId` means "no current task" (TUI shows phase: idle).
 */
export interface CurrentTaskPointer {
  readonly activeTaskId: string | null;
}

export const CurrentTaskPointerSchema = z.object({
  activeTaskId: z.string().min(1).nullable()
});

/**
 * Signals the router consults when deciding whether to advance phases.
 * In slice 1 most signals are stub-false; later slices populate them
 * from real artefact existence checks (CONTEXT.md, PLAN.xml, worktree
 * state, verify results).
 */
export interface PhaseSignals {
  /** True once the discover-phase interview has produced a CONTEXT.md. */
  readonly hasContextDoc: boolean;
  /** True once a plan has been generated and passed plan-checker. */
  readonly hasPlanDoc: boolean;
  /** True once every executor worktree has committed its tasks. */
  readonly allTasksCommitted: boolean;
  /** True once every `<verify>` command has exited 0. */
  readonly allVerifyPassed: boolean;
}

export const emptySignals = (): PhaseSignals => ({
  hasContextDoc: false,
  hasPlanDoc: false,
  allTasksCommitted: false,
  allVerifyPassed: false
});

/**
 * The classifier decides the next phase given current state, the most
 * recent user message, and the world signals. Returning the same
 * phase as `state.phase` means "stay" (no transition). The router
 * never advances *backwards* automatically — only `/back` does that
 * explicitly.
 */
export interface ClassifyInput {
  readonly state: TaskState | null;
  readonly userMessage: string;
  readonly signals: PhaseSignals;
}

export interface ClassifyResult {
  readonly nextPhase: Phase;
  /** One-line reason surfaced in `/status` and the audit log. */
  readonly reason: string;
  /**
   * If true, the caller should treat this as a brand-new task
   * (allocate id, derive title from `userMessage`). Only set when
   * transitioning from `idle` → `discover`.
   */
  readonly startsNewTask?: boolean;
}
