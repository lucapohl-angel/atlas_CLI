/**
 * Per-task discover-phase warnings buffer.
 *
 * Some discover-phase guardrails (most notably the multi-question
 * detector) want to nudge the model on the *next* turn rather than
 * block the current one. Hooks have no direct access to the system
 * prompt, so they append guidance to a per-task file here. The TUI
 * reads + clears this buffer when assembling the next system message
 * and concatenates the lines onto the phase addendum.
 *
 * The file is plain text, one warning per line. It lives next to the
 * task's CONTEXT.md so it shares the same lifecycle (gone when the
 * task directory is removed).
 */
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import { taskDir } from './state.js';
import type { TaskState } from './types.js';

export const DISCOVER_WARNINGS_FILENAME = '.discover-warnings.txt';

const warningsPath = (state: TaskState): string =>
  join(taskDir(state.cwd, state.id), DISCOVER_WARNINGS_FILENAME);

const fileExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** Append a single warning line to the buffer. Trims; dedupes against the most recent line. */
export const appendDiscoverWarning = async (
  state: TaskState,
  warning: string
): Promise<Result<void, AtlasError>> => {
  const trimmed = warning.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return ok(undefined);
  const path = warningsPath(state);
  try {
    await mkdir(join(path, '..'), { recursive: true });
    if (await fileExists(path)) {
      const cur = await readFile(path, 'utf8');
      const lastLine = cur.trimEnd().split('\n').pop() ?? '';
      if (lastLine === trimmed) return ok(undefined);
    }
    await writeFile(path, trimmed + '\n', { flag: 'a', encoding: 'utf8' });
    return ok(undefined);
  } catch (e) {
    return err(
      atlasError('WORKFLOW_STATE_WRITE_FAILED', 'failed to append discover warning', {
        cause: e
      })
    );
  }
};

/**
 * Read every pending warning, then delete the file. Returns an empty
 * array when no warnings are pending. Safe to call every turn.
 */
export const consumeDiscoverWarnings = async (
  state: TaskState
): Promise<readonly string[]> => {
  const path = warningsPath(state);
  if (!(await fileExists(path))) return [];
  try {
    const raw = await readFile(path, 'utf8');
    await unlink(path).catch(() => {
      /* best effort */
    });
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
};
