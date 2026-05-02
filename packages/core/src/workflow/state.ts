/**
 * Workflow state persistence — task state on disk.
 *
 * Layout (per cwd):
 *   <cwd>/.atlas/tasks/current.json          — pointer to active task
 *   <cwd>/.atlas/tasks/<id>/state.json       — task state
 *   <cwd>/.atlas/tasks/<id>/CONTEXT.md       — slice 2
 *   <cwd>/.atlas/tasks/<id>/PLAN.xml         — slice 2
 *
 * All writes are atomic (tmp + rename). Reads are tolerant of missing
 * files — they return `ok(null)` for "no active task" rather than
 * raising, since "fresh repo" is a common, expected state.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import { err, ok, type Result } from '../result.js';
import {
  CurrentTaskPointerSchema,
  TaskStateSchema,
  type CurrentTaskPointer,
  type Phase,
  type TaskState
} from './types.js';

const log = childLogger('workflow.state');

export const tasksRoot = (cwd: string): string => join(cwd, '.atlas', 'tasks');

export const taskDir = (cwd: string, id: string): string =>
  join(tasksRoot(cwd), id);

export const taskStatePath = (cwd: string, id: string): string =>
  join(taskDir(cwd, id), 'state.json');

export const currentTaskPointerPath = (cwd: string): string =>
  join(tasksRoot(cwd), 'current.json');

const isMissingFile = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  'code' in e &&
  (e as { code: unknown }).code === 'ENOENT';

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

export const loadCurrentTaskPointer = async (
  cwd: string
): Promise<Result<CurrentTaskPointer, AtlasError>> => {
  const path = currentTaskPointerPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if (isMissingFile(e)) return ok({ activeTaskId: null });
    return err(
      atlasError('WORKFLOW_STATE_PARSE_FAILED', `failed to read ${path}`, {
        cause: e
      })
    );
  }
  try {
    const parsed = CurrentTaskPointerSchema.parse(JSON.parse(raw));
    return ok(parsed);
  } catch (e) {
    return err(
      atlasError('WORKFLOW_STATE_PARSE_FAILED', `invalid current.json at ${path}`, {
        cause: e
      })
    );
  }
};

export const saveCurrentTaskPointer = async (
  cwd: string,
  pointer: CurrentTaskPointer
): Promise<Result<void, AtlasError>> => {
  try {
    await writeAtomic(currentTaskPointerPath(cwd), JSON.stringify(pointer, null, 2));
    return ok(undefined);
  } catch (e) {
    return err(
      atlasError('WORKFLOW_STATE_WRITE_FAILED', 'failed to write current task pointer', {
        cause: e
      })
    );
  }
};

export const loadTaskState = async (
  cwd: string,
  id: string
): Promise<Result<TaskState | null, AtlasError>> => {
  const path = taskStatePath(cwd, id);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if (isMissingFile(e)) return ok(null);
    return err(
      atlasError('WORKFLOW_STATE_PARSE_FAILED', `failed to read ${path}`, {
        cause: e
      })
    );
  }
  try {
    const parsed = TaskStateSchema.parse(JSON.parse(raw));
    return ok(parsed);
  } catch (e) {
    return err(
      atlasError('WORKFLOW_STATE_PARSE_FAILED', `invalid task state at ${path}`, {
        cause: e
      })
    );
  }
};

export const saveTaskState = async (
  state: TaskState
): Promise<Result<void, AtlasError>> => {
  try {
    await writeAtomic(
      taskStatePath(state.cwd, state.id),
      JSON.stringify(state, null, 2)
    );
    return ok(undefined);
  } catch (e) {
    return err(
      atlasError('WORKFLOW_STATE_WRITE_FAILED', 'failed to write task state', {
        cause: e,
        context: { id: state.id }
      })
    );
  }
};

/**
 * Convenience: load the active task for a cwd in one call. Returns
 * `ok(null)` when no current.json exists, when its activeTaskId is
 * null, or when the referenced state.json is missing. The latter is
 * treated as "no active task" rather than a hard error so a stale
 * pointer never blocks the TUI from booting.
 */
export const loadActiveTask = async (
  cwd: string
): Promise<Result<TaskState | null, AtlasError>> => {
  const pointer = await loadCurrentTaskPointer(cwd);
  if (!pointer.ok) return pointer;
  if (!pointer.value.activeTaskId) return ok(null);
  const loaded = await loadTaskState(cwd, pointer.value.activeTaskId);
  if (!loaded.ok) return loaded;
  if (!loaded.value) {
    log.warn(
      { id: pointer.value.activeTaskId },
      'current.json points at missing task state — treating as no active task'
    );
  }
  return ok(loaded.value);
};

/**
 * Generate a stable task id from the current time. Format:
 * `YYYYMMDD-HHMMSS-XXXX` where XXXX is a 4-char random suffix. Sorts
 * lexicographically by creation time — handy for `ls`-style listings.
 */
export const newTaskId = (now: Date = new Date()): string => {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const ymd = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const hms = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const rnd = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `${ymd}-${hms}-${rnd}`;
};

/**
 * Derive a short human-readable title from the user's first message.
 * Trimmed to ~60 chars on a word boundary so it fits the TUI status
 * line without truncation.
 */
export const titleFromMessage = (message: string): string => {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 60) return oneLine;
  const cut = oneLine.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + '…';
};

/**
 * Create + persist a fresh task. Returns the new state on success.
 * Also rewrites `current.json` to point at the new task atomically
 * (the pointer is written *after* the state file so a crash mid-call
 * leaves an orphan task file rather than a dangling pointer).
 */
export interface StartTaskOpts {
  readonly cwd: string;
  readonly title: string;
  readonly phase?: Phase;
  readonly note?: string;
  readonly now?: Date;
}

export const startTask = async (
  opts: StartTaskOpts
): Promise<Result<TaskState, AtlasError>> => {
  const now = opts.now ?? new Date();
  const iso = now.toISOString();
  const state: TaskState = {
    id: newTaskId(now),
    title: opts.title,
    phase: opts.phase ?? 'discover',
    cwd: opts.cwd,
    createdAt: iso,
    updatedAt: iso,
    ...(opts.note ? { note: opts.note } : {})
  };
  const wrote = await saveTaskState(state);
  if (!wrote.ok) return wrote;
  const pointed = await saveCurrentTaskPointer(opts.cwd, {
    activeTaskId: state.id
  });
  if (!pointed.ok) return pointed;
  return ok(state);
};

/**
 * Transition the active task to a new phase (or update the note /
 * artefact paths). Bumps `updatedAt` automatically. Persists the new
 * state to disk before returning.
 */
export interface UpdateTaskPatch {
  readonly phase?: Phase;
  readonly note?: string;
  readonly contextDocPath?: string;
  readonly planDocPath?: string;
  readonly worktreeIds?: readonly string[];
}

export const updateTask = async (
  state: TaskState,
  patch: UpdateTaskPatch,
  now: Date = new Date()
): Promise<Result<TaskState, AtlasError>> => {
  const next: TaskState = {
    ...state,
    ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(patch.contextDocPath !== undefined
      ? { contextDocPath: patch.contextDocPath }
      : {}),
    ...(patch.planDocPath !== undefined ? { planDocPath: patch.planDocPath } : {}),
    ...(patch.worktreeIds !== undefined ? { worktreeIds: patch.worktreeIds } : {}),
    updatedAt: now.toISOString()
  };
  const wrote = await saveTaskState(next);
  if (!wrote.ok) return wrote;
  return ok(next);
};

/**
 * Clear the active-task pointer. Does not delete the task state on
 * disk — callers can `/resume` the task later if they want. Used by
 * `/abort` and on natural completion (`ship` → idle).
 */
export const clearActiveTask = async (
  cwd: string
): Promise<Result<void, AtlasError>> => saveCurrentTaskPointer(cwd, { activeTaskId: null });
