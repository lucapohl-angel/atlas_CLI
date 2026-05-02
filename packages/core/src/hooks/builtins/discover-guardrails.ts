/**
 * Discover-phase guardrails — turn the soft prompt-level rules into
 * actual hook-level enforcement.
 *
 * Three hooks, all gated by the `guardrails.discoverGuardrails`
 * config flag and parameterized by the workspace `cwd` so they can
 * resolve the active task on demand:
 *
 *   - vaguenessHook        beforeTool on `context_set`. If the most
 *                          recent user message tripped the vagueness
 *                          detector, blocks the write and tells the
 *                          model to call `clarify` first.
 *   - contradictionHook    beforeTool on `context_set`. Runs a small
 *                          keyword/antonym sweep against existing
 *                          slot bullets. On a likely contradiction,
 *                          blocks with a reconciliation prompt.
 *   - multiQuestionHook    afterMessage on assistant turns. When the
 *                          message contains multiple "?" sentences,
 *                          appends a soft warning to the per-task
 *                          discover-warnings buffer (which the TUI
 *                          re-injects into the next system prompt).
 *
 * All three are tolerant: any errors reading task state degrade to
 * "allow", because guardrails should never break the loop.
 */
import { loadActiveTask } from '../../workflow/state.js';
import { readSlots, type ContextSlots } from '../../workflow/slots.js';
import { appendDiscoverWarning } from '../../workflow/discover-warnings.js';
import type { TaskState } from '../../workflow/types.js';
import type { HookSpec } from '../types.js';

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

const VAGUE_PATTERNS: readonly RegExp[] = [
  /\b(idk|i don'?t know|not sure|no idea|dunno)\b/i,
  /\b(you (decide|pick|choose|tell me)|whatever( you (think|want))?|up to you|your call|doesn'?t matter|don'?t care)\b/i,
  /\b(any(thing|way)? (is fine|works|you (like|prefer)))\b/i,
  /\b(surprise me)\b/i
];

/**
 * Heuristic vagueness detector. The user's text counts as vague when
 * it matches one of the explicit patterns or when it's both short
 * (<6 words) and lacks any concrete noun-like token.
 */
export const isVagueUserMessage = (text: string): boolean => {
  const t = text.trim();
  if (t.length === 0) return false;
  for (const p of VAGUE_PATTERNS) if (p.test(t)) return true;
  const words = t.split(/\s+/);
  if (words.length <= 5) {
    // Short replies like "ok", "yes", "sure", "k" are too thin to act
    // on as a slot value (they're a meta-confirmation, not content).
    if (/^(ok|okay|sure|yes|yep|yeah|y|nope|no|n|k|kk|fine|cool|alright)\b[\s.!?]*$/i.test(t)) {
      return true;
    }
  }
  return false;
};

/**
 * Antonym pairs scanned across slot contents. Each entry is a pair of
 * regexes. If a new value matches `a` and any existing bullet (across
 * the user-supplied related slots) matches `b`, or vice versa, we flag
 * a probable contradiction.
 *
 * This is intentionally conservative — a few obvious axes only.
 * Smarter detection is a job for a small LLM call; the keyword sweep
 * is the cheap-but-useful first pass.
 */
interface AntonymPair {
  readonly label: string;
  readonly a: RegExp;
  readonly b: RegExp;
}

const ANTONYM_PAIRS: readonly AntonymPair[] = [
  {
    label: 'performance',
    a: /\b(fast|quick|low[\s-]?latency|<\s*\d+\s*(ms|s)\b|\d+\s*ms\b|sub-?second|realtime|real[\s-]time|snappy)\b/i,
    b: /\b(slow ok|no rush|perf(?:ormance)? (?:doesn'?t|does not) matter|latency (?:doesn'?t|does not) matter|not perf-?sensitive)\b/i
  },
  {
    label: 'security / auth',
    a: /\b(private|internal|auth(?:enticated)?|requires? (?:auth|login|sign-?in)|protected)\b/i,
    b: /\b(public|open access|no auth|anonymous|unauthenticated|world-?readable)\b/i
  },
  {
    label: 'requirement strength',
    a: /\b(must|required|mandatory|critical|non[\s-]negotiable)\b/i,
    b: /\b(optional|nice[\s-]to[\s-]have|maybe|if there'?s time|stretch goal)\b/i
  },
  {
    label: 'language',
    a: /\btypescript\b/i,
    b: /\b(plain |vanilla )?javascript\b(?!.*typescript)/i
  },
  {
    label: 'maturity',
    a: /\b(production|prod|enterprise|battle[\s-]tested|reliable)\b/i,
    b: /\b(prototype|throw[\s-]?away|poc|proof[\s-]of[\s-]concept|hack|mvp only)\b/i
  },
  {
    label: 'scope',
    a: /\b(minimal|lean|smallest|just (?:enough|the))\b/i,
    b: /\b(feature[\s-]rich|complete|full|comprehensive|everything)\b/i
  }
];

/** Collect all bullets across the slot record (and the goal text). */
const allSlotText = (slots: ContextSlots): readonly string[] => [
  slots.goal,
  ...slots.successCriteria,
  ...slots.constraints,
  ...slots.context,
  ...slots.outOfScope,
  ...slots.openQuestions
];

interface ContradictionHit {
  readonly label: string;
  readonly newValue: string;
  readonly existing: string;
}

export const detectContradictions = (
  newValue: string,
  slots: ContextSlots
): readonly ContradictionHit[] => {
  const hits: ContradictionHit[] = [];
  const existing = allSlotText(slots).filter((s) => s.trim().length > 0);
  for (const pair of ANTONYM_PAIRS) {
    const newHitsA = pair.a.test(newValue);
    const newHitsB = pair.b.test(newValue);
    if (!newHitsA && !newHitsB) continue;
    for (const ex of existing) {
      const exHitsA = pair.a.test(ex);
      const exHitsB = pair.b.test(ex);
      if ((newHitsA && exHitsB) || (newHitsB && exHitsA)) {
        hits.push({ label: pair.label, newValue, existing: ex });
      }
    }
  }
  return hits;
};

/**
 * Count distinct sentence-ending question marks. Question marks
 * inside parenthetical asides are still counted (good enough for
 * a heuristic; the goal is to catch obvious "Q1? Q2? Q3?" turns,
 * not to be a parser).
 */
export const countQuestions = (text: string): number => {
  const matches = text.match(/\?/g);
  return matches ? matches.length : 0;
};

/** Resolve the active task for `cwd`, or null when there's no active task / on error. */
const safeActiveTask = async (cwd: string): Promise<TaskState | null> => {
  try {
    const r = await loadActiveTask(cwd);
    if (!r.ok) return null;
    return r.value;
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ */
/* vaguenessHook                                                      */
/* ------------------------------------------------------------------ */

export const vaguenessHook = (cwd: string): HookSpec<'beforeTool'> => ({
  event: 'beforeTool',
  matcher: 'context_set',
  handler: async (ctx) => {
    const last = ctx.lastUserMessage;
    if (!last || !isVagueUserMessage(last)) return { action: 'allow' };
    const task = await safeActiveTask(cwd);
    if (!task || task.phase !== 'discover') return { action: 'allow' };
    const slot = (ctx.input as { slot?: string } | null)?.slot ?? 'unknown';
    return {
      action: 'block',
      reason:
        `discover-guardrail: the last user reply ("${last.trim().slice(0, 80)}") was vague, ` +
        `but you tried to write slot \`${slot}\` anyway. Call \`clarify\` first with 2–4 ` +
        `plausible options + one-line tradeoffs, wait for the user's pick, then call ` +
        `context_set with the chosen value.`
    };
  }
});

/* ------------------------------------------------------------------ */
/* contradictionHook                                                  */
/* ------------------------------------------------------------------ */

export const contradictionHook = (cwd: string): HookSpec<'beforeTool'> => ({
  event: 'beforeTool',
  matcher: 'context_set',
  handler: async (ctx) => {
    const input = ctx.input as { slot?: string; content?: string } | null;
    const content = typeof input?.content === 'string' ? input.content : '';
    if (content.trim().length === 0) return { action: 'allow' };
    const task = await safeActiveTask(cwd);
    if (!task) return { action: 'allow' };
    const slotsR = await readSlots(task);
    if (!slotsR.ok) return { action: 'allow' };
    const hits = detectContradictions(content, slotsR.value);
    if (hits.length === 0) return { action: 'allow' };
    const first = hits[0];
    if (!first) return { action: 'allow' };
    return {
      action: 'block',
      reason:
        `discover-guardrail: likely contradiction (${first.label}). ` +
        `New value: "${first.newValue.slice(0, 100)}". ` +
        `Existing slot value: "${first.existing.slice(0, 100)}". ` +
        `Ask the user which one is correct, update the wrong slot via context_set, ` +
        `then retry.`
    };
  }
});

/* ------------------------------------------------------------------ */
/* multiQuestionHook                                                  */
/* ------------------------------------------------------------------ */

export const multiQuestionHook = (cwd: string): HookSpec<'afterMessage'> => ({
  event: 'afterMessage',
  handler: async (ctx) => {
    if (ctx.role !== 'assistant') return { action: 'allow' };
    const n = countQuestions(ctx.content);
    if (n <= 1) return { action: 'allow' };
    const task = await safeActiveTask(cwd);
    if (!task || task.phase !== 'discover') return { action: 'allow' };
    await appendDiscoverWarning(
      task,
      `Your previous turn asked ${n} questions. Per the discover-phase protocol: one focused question per turn. Pick the single most important one for the next turn and ask only that.`
    );
    return { action: 'allow' };
  }
});
