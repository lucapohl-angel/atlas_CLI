/**
 * Discover-phase context slots — the structured shape every CONTEXT.md
 * gets composed from at finalize time.
 *
 * Atlas's discover phase used to accumulate free-form Q+A in
 * `CONTEXT.draft.md`. That worked for narrative but made it easy for
 * the planner to start without a clear goal or success criteria.
 * Slots make the contract explicit:
 *
 *   - goal              required, single sentence
 *   - successCriteria   required, ≥1 testable bullet
 *   - constraints       optional bullets (stack, perf, files-not-to-touch)
 *   - context           optional bullets (relevant files, prior decisions)
 *   - outOfScope        optional bullets (things the agent must NOT do)
 *   - openQuestions     optional bullets (acknowledged unknowns)
 *
 * Slots live in a JSON sidecar (`CONTEXT.slots.json`) so we can
 * validate at finalize time and re-render the markdown deterministically.
 * The free-form Q+A log (`CONTEXT.draft.md`, written by `context_note`)
 * is appended after the structured sections in the final file.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import { taskDir } from './state.js';
import type { TaskState } from './types.js';

export const CONTEXT_SLOTS_FILENAME = 'CONTEXT.slots.json';

/** The six slot ids. Order is the order they're rendered in CONTEXT.md. */
export const SLOT_IDS = [
  'goal',
  'success',
  'constraints',
  'context',
  'out_of_scope',
  'open_questions'
] as const;

export type SlotId = (typeof SLOT_IDS)[number];

/**
 * Slots that must be non-empty before `context_finalize` accepts.
 *
 * All six slots are required so the discover phase produces a fully
 * structured brief. For slots that legitimately have nothing to put
 * in them (most often `out_of_scope` and `open_questions`), the model
 * must write the literal string "none" via `context_set`. That forces
 * a deliberate decision rather than a silent oversight.
 */
export const REQUIRED_SLOTS: readonly SlotId[] = SLOT_IDS;

const SLOT_HEADINGS: Record<SlotId, string> = {
  goal: 'Goal',
  success: 'Success criteria',
  constraints: 'Constraints',
  context: 'Context',
  out_of_scope: 'Out of scope',
  open_questions: 'Open questions'
};

/** Slot data on disk. `goal` is a single string; the rest are bullet lists. */
export interface ContextSlots {
  readonly goal: string;
  readonly successCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly context: readonly string[];
  readonly outOfScope: readonly string[];
  readonly openQuestions: readonly string[];
}

const ContextSlotsSchema = z.object({
  goal: z.string(),
  successCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  context: z.array(z.string()),
  outOfScope: z.array(z.string()),
  openQuestions: z.array(z.string())
});

export const emptySlots = (): ContextSlots => ({
  goal: '',
  successCriteria: [],
  constraints: [],
  context: [],
  outOfScope: [],
  openQuestions: []
});

const slotsPath = (state: TaskState): string =>
  join(taskDir(state.cwd, state.id), CONTEXT_SLOTS_FILENAME);

const fileExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** Read slots, returning an empty record when no sidecar exists yet. */
export const readSlots = async (
  state: TaskState
): Promise<Result<ContextSlots, AtlasError>> => {
  const path = slotsPath(state);
  if (!(await fileExists(path))) return ok(emptySlots());
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = ContextSlotsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return err(
        atlasError(
          'WORKFLOW_STATE_PARSE_FAILED',
          `CONTEXT.slots.json: invalid shape (${parsed.error.issues.map((i) => i.path.join('.')).join(', ')})`
        )
      );
    }
    return ok(parsed.data);
  } catch (e) {
    return err(
      atlasError('WORKFLOW_STATE_PARSE_FAILED', 'failed to read CONTEXT.slots.json', { cause: e })
    );
  }
};

const writeSlots = async (
  state: TaskState,
  slots: ContextSlots
): Promise<Result<void, AtlasError>> => {
  const path = slotsPath(state);
  try {
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(slots, null, 2) + '\n', 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, path);
    return ok(undefined);
  } catch (e) {
    return err(
      atlasError('WORKFLOW_STATE_WRITE_FAILED', 'failed to write CONTEXT.slots.json', { cause: e })
    );
  }
};

/**
 * Write `goal` (replaces) or append a bullet to one of the list-shaped
 * slots. Trims the input; rejects empty strings. Returns the updated
 * slot record.
 */
export const setSlot = async (
  state: TaskState,
  slot: SlotId,
  content: string
): Promise<Result<ContextSlots, AtlasError>> => {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return err(atlasError('TOOL_EXECUTION_FAILED', `slot ${slot}: content is empty`));
  }
  const cur = await readSlots(state);
  if (!cur.ok) return cur;
  const next: ContextSlots =
    slot === 'goal'
      ? { ...cur.value, goal: trimmed }
      : slot === 'success'
        ? { ...cur.value, successCriteria: [...cur.value.successCriteria, trimmed] }
        : slot === 'constraints'
          ? { ...cur.value, constraints: [...cur.value.constraints, trimmed] }
          : slot === 'context'
            ? { ...cur.value, context: [...cur.value.context, trimmed] }
            : slot === 'out_of_scope'
              ? { ...cur.value, outOfScope: [...cur.value.outOfScope, trimmed] }
              : { ...cur.value, openQuestions: [...cur.value.openQuestions, trimmed] };
  const w = await writeSlots(state, next);
  if (!w.ok) return w;
  return ok(next);
};

/**
 * Return the list of required slots that are still empty. Empty array
 * means the slots are ready to finalize. All six slots are required;
 * use the literal string "none" for slots that have no content.
 */
export const missingRequiredSlots = (slots: ContextSlots): readonly SlotId[] => {
  const missing: SlotId[] = [];
  if (slots.goal.trim().length === 0) missing.push('goal');
  if (slots.successCriteria.length === 0) missing.push('success');
  if (slots.constraints.length === 0) missing.push('constraints');
  if (slots.context.length === 0) missing.push('context');
  if (slots.outOfScope.length === 0) missing.push('out_of_scope');
  if (slots.openQuestions.length === 0) missing.push('open_questions');
  return missing;
};

/** Pretty status line for `context_status`. */
export const formatSlotStatus = (slots: ContextSlots): string => {
  const lines: string[] = [];
  for (const id of SLOT_IDS) {
    const heading = SLOT_HEADINGS[id];
    const required = REQUIRED_SLOTS.includes(id) ? ' (required)' : '';
    const count =
      id === 'goal'
        ? slots.goal.trim().length === 0
          ? 'empty'
          : '1 sentence'
        : (() => {
            const n =
              id === 'success'
                ? slots.successCriteria.length
                : id === 'constraints'
                  ? slots.constraints.length
                  : id === 'context'
                    ? slots.context.length
                    : id === 'out_of_scope'
                      ? slots.outOfScope.length
                      : slots.openQuestions.length;
            return n === 0 ? 'empty' : `${n} bullet${n === 1 ? '' : 's'}`;
          })();
    lines.push(`- ${heading}${required}: ${count}`);
  }
  const missing = missingRequiredSlots(slots);
  if (missing.length > 0) {
    lines.push('', `still required before finalize: ${missing.join(', ')}`);
  } else {
    lines.push('', 'ready to finalize');
  }
  return lines.join('\n');
};

/**
 * Render the canonical CONTEXT.md body from the slot record. Empty
 * list-slots render the heading with `_(none)_` so reviewers can see
 * the section was deliberately left blank, not forgotten.
 */
export const renderSlotsMarkdown = (slots: ContextSlots): string => {
  const sections: string[] = [];
  sections.push('## Goal\n\n' + (slots.goal.trim().length > 0 ? slots.goal.trim() : '_(none)_'));
  const list = (heading: string, items: readonly string[]): string => {
    const body =
      items.length === 0 ? '_(none)_' : items.map((i) => `- ${i}`).join('\n');
    return `## ${heading}\n\n${body}`;
  };
  sections.push(list('Success criteria', slots.successCriteria));
  sections.push(list('Constraints', slots.constraints));
  sections.push(list('Context', slots.context));
  sections.push(list('Out of scope', slots.outOfScope));
  sections.push(list('Open questions', slots.openQuestions));
  return sections.join('\n\n') + '\n';
};
