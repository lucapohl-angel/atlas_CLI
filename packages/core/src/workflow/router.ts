/**
 * Phase router — maps (current state, user message, world signals) to
 * the next phase. Slice 1 is rule-based and deterministic so it can be
 * unit-tested without an LLM in the loop. Slice 2 will plug in an
 * intent classifier for the genuinely ambiguous cases (e.g.
 * mid-execute "wait actually let's rethink" → bump back to plan).
 *
 * The router never advances *backwards* automatically. `/back` is the
 * only way to rewind; this keeps the implicit pipeline predictable.
 */
import type {
  ClassifyInput,
  ClassifyResult,
  Phase,
  PhaseSignals,
  TaskState
} from './types.js';
import { PHASES } from './types.js';

const phaseIndex = (p: Phase): number => PHASES.indexOf(p);

const isTrivial = (msg: string): boolean => {
  const t = msg.trim();
  if (t.length < 3) return true;
  // Pure-slash commands are routed by the TUI, not by us, but we still
  // see the raw text. Treat them as trivial so they don't accidentally
  // start a new task.
  if (t.startsWith('/')) return true;
  // Common acknowledgments that shouldn't reset the task.
  return /^(ok|yes|y|no|n|sure|go|do it|continue|next|thanks?)\b/i.test(t);
};

/**
 * The slice-1 classifier. Pure function, no I/O. Behavior:
 *
 *   no task + non-trivial message  → start new task in `discover`
 *   discover + hasContextDoc       → `plan`
 *   plan     + hasPlanDoc          → `execute`
 *   execute  + allTasksCommitted   → `verify`
 *   verify   + allVerifyPassed     → `ship`
 *   anything else                  → stay
 *
 * Trivial messages (acks, very short text, slash commands) never
 * transition. New tasks are only born from the `idle` state.
 */
export const classifyIntent = (input: ClassifyInput): ClassifyResult => {
  const { state, userMessage, signals } = input;

  if (!state) {
    if (isTrivial(userMessage)) {
      return { nextPhase: 'idle', reason: 'no active task; message is trivial' };
    }
    return {
      nextPhase: 'discover',
      reason: 'new task — entering discover',
      startsNewTask: true
    };
  }

  switch (state.phase) {
    case 'idle':
      if (isTrivial(userMessage)) {
        return { nextPhase: 'idle', reason: 'idle; message is trivial' };
      }
      return {
        nextPhase: 'discover',
        reason: 'new task — entering discover',
        startsNewTask: true
      };
    case 'discover':
      if (signals.hasContextDoc) {
        return {
          nextPhase: 'plan',
          reason: 'CONTEXT.md ready — advancing to plan'
        };
      }
      return { nextPhase: 'discover', reason: 'still gathering context' };
    case 'plan':
      if (signals.hasPlanDoc) {
        return {
          nextPhase: 'execute',
          reason: 'plan checked in — advancing to execute'
        };
      }
      return { nextPhase: 'plan', reason: 'plan still drafting' };
    case 'execute':
      if (signals.allTasksCommitted) {
        return {
          nextPhase: 'verify',
          reason: 'all tasks committed — advancing to verify'
        };
      }
      return { nextPhase: 'execute', reason: 'tasks still in flight' };
    case 'verify':
      if (signals.allVerifyPassed) {
        return {
          nextPhase: 'ship',
          reason: 'verify all green — ready to ship'
        };
      }
      return { nextPhase: 'verify', reason: 'verify in progress' };
    case 'ship':
      return { nextPhase: 'ship', reason: 'awaiting ship action' };
  }
};

/**
 * Validate an explicit user-driven phase change (`/back <phase>`).
 * Allows backwards moves and stay-in-place; refuses forward jumps so
 * users can't accidentally skip the discover/plan steps that the
 * downstream phases depend on. Skipping forward is what `/skip` is
 * for, and it's intentionally separate.
 */
export const canRewindTo = (
  state: TaskState,
  target: Phase
): { ok: true } | { ok: false; reason: string } => {
  if (target === state.phase) {
    return { ok: false, reason: `already in ${target}` };
  }
  if (phaseIndex(target) > phaseIndex(state.phase)) {
    return {
      ok: false,
      reason: `cannot rewind forward (${state.phase} → ${target}); use /skip`
    };
  }
  return { ok: true };
};

/**
 * Convenience used by the TUI status command — formats a one-line
 * phase summary with the state's note and the most recent signals.
 */
export const formatPhaseLine = (
  state: TaskState | null,
  signals: PhaseSignals = {
    hasContextDoc: false,
    hasPlanDoc: false,
    allTasksCommitted: false,
    allVerifyPassed: false
  }
): string => {
  if (!state) return 'phase: idle (no active task)';
  const parts = [`phase: ${state.phase}`];
  if (state.note) parts.push(state.note);
  const flags: string[] = [];
  if (signals.hasContextDoc) flags.push('CONTEXT.md');
  if (signals.hasPlanDoc) flags.push('PLAN.xml');
  if (signals.allTasksCommitted) flags.push('committed');
  if (signals.allVerifyPassed) flags.push('verify-green');
  if (flags.length > 0) parts.push(`[${flags.join(', ')}]`);
  return parts.join(' · ');
};
