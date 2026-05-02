/**
 * CONTEXT.md helpers — silent artefact generation during the
 * `discover` phase.
 *
 * The model accumulates clarifying Q&A and free-form notes into
 * `CONTEXT.draft.md` as the conversation progresses, then calls
 * `finalizeContext` when the gray-area set is empty. Finalization
 * promotes the draft to `CONTEXT.md`, which the slice-1 signal probe
 * picks up on the next user message and advances the phase to `plan`.
 *
 * No XML, no schema — context is human-prose markdown so the user can
 * eyeball it (and edit it) at any time.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import {
  missingRequiredSlots,
  readSlots,
  renderSlotsMarkdown,
  type SlotId
} from './slots.js';
import { taskDir } from './state.js';
import type { TaskState } from './types.js';

export const CONTEXT_FILENAME = 'CONTEXT.md';
export const CONTEXT_DRAFT_FILENAME = 'CONTEXT.draft.md';

export interface ContextEntry {
  /** Free-form section heading. Examples: "Q: pick a database", "Note: API style". */
  readonly heading: string;
  /** The body text under the heading. Markdown allowed. */
  readonly body: string;
  /** Optional one-word category for at-a-glance grouping. */
  readonly category?: string;
}

const contextDraftPath = (state: TaskState): string =>
  join(taskDir(state.cwd, state.id), CONTEXT_DRAFT_FILENAME);

const contextFinalPath = (state: TaskState): string =>
  join(taskDir(state.cwd, state.id), CONTEXT_FILENAME);

const fileExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const ensureHeader = async (state: TaskState): Promise<string> => {
  const path = contextDraftPath(state);
  if (await fileExists(path)) return path;
  await mkdir(join(path, '..'), { recursive: true });
  const header =
    `# Context: ${state.title}\n\n` +
    `> Task: ${state.id}\n` +
    `> Started: ${state.createdAt}\n\n` +
    `<!-- entries appended by the model via context_note -->\n\n`;
  await writeFile(path, header, 'utf8');
  return path;
};

/**
 * Append a Q&A or note to the draft context file. Creates the file
 * with a stable header on first call. Each entry is separated by a
 * single blank line so the markdown stays readable.
 */
export const appendContextEntry = async (
  state: TaskState,
  entry: ContextEntry
): Promise<Result<void, AtlasError>> => {
  try {
    const path = await ensureHeader(state);
    const cat = entry.category ? ` *(category: ${entry.category})*` : '';
    const block = `## ${entry.heading}${cat}\n\n${entry.body.trim()}\n\n`;
    await writeFile(path, block, { flag: 'a', encoding: 'utf8' });
    return ok(undefined);
  } catch (e) {
    return err(
      atlasError('WORKFLOW_STATE_WRITE_FAILED', 'failed to append context entry', {
        cause: e
      })
    );
  }
};

/**
 * Read the draft (or the finalized file, whichever exists). Returns
 * `null` if neither exists yet — calling this is always safe.
 */
export const readContext = async (
  state: TaskState
): Promise<Result<string | null, AtlasError>> => {
  const final = contextFinalPath(state);
  const draft = contextDraftPath(state);
  try {
    if (await fileExists(final)) return ok(await readFile(final, 'utf8'));
    if (await fileExists(draft)) return ok(await readFile(draft, 'utf8'));
    return ok(null);
  } catch (e) {
    return err(
      atlasError('WORKFLOW_STATE_PARSE_FAILED', 'failed to read context', {
        cause: e
      })
    );
  }
};

/**
 * Promote the draft to `CONTEXT.md`. The slice-1 signal probe picks
 * up the renamed file on the next user message and the router
 * advances the phase to `plan`.
 *
 * Finalization requires that the structured slot sidecar
 * (`CONTEXT.slots.json`, written via `context_set`) has at minimum
 * a `goal` and one success-criterion bullet. Free-form Q+A
 * collected via `context_note` is appended after the rendered
 * slots so reviewers still see the conversation that produced the
 * brief.
 */
export const finalizeContext = async (
  state: TaskState,
  summary?: string
): Promise<
  Result<{ readonly path: string; readonly missing: readonly SlotId[] }, AtlasError>
> => {
  const slotsR = await readSlots(state);
  if (!slotsR.ok) return slotsR;
  const missing = missingRequiredSlots(slotsR.value);
  if (missing.length > 0) {
    return err(
      atlasError(
        'WORKFLOW_STATE_WRITE_FAILED',
        `cannot finalize: required slots empty (${missing.join(', ')}). All six slots are required — call context_set for each missing slot. Use content "none" for slots that have nothing to record.`
      )
    );
  }
  const draft = contextDraftPath(state);
  const final = contextFinalPath(state);
  const draftBody = (await fileExists(draft)) ? await readFile(draft, 'utf8') : '';
  try {
    const header = `# Context: ${state.title}\n\n` +
      `> Task: ${state.id}\n` +
      `> Started: ${state.createdAt}\n\n`;
    const slotsMd = renderSlotsMarkdown(slotsR.value);
    const summaryBlock = summary ? `## Summary\n\n${summary.trim()}\n\n` : '';
    // Strip the auto-header from the legacy draft so we don't repeat it.
    const log = draftBody
      .replace(/^# Context:[\s\S]*?<!-- entries appended[^\n]*-->\n+/, '')
      .trim();
    const logBlock = log.length > 0 ? `## Discovery log\n\n${log}\n\n` : '';
    const body =
      header + slotsMd + '\n' + summaryBlock + logBlock + '<!-- atlas:finalized -->\n';
    await mkdir(join(final, '..'), { recursive: true });
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, final);
    return ok({ path: final, missing });
  } catch (e) {
    return err(
      atlasError('WORKFLOW_STATE_WRITE_FAILED', 'failed to finalize context', {
        cause: e
      })
    );
  }
};
