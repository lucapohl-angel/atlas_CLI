/**
 * Workflow signals — read the world (artefact paths, worktree state)
 * to derive the boolean flags the router consults when advancing
 * phases. Slice 1 only knows how to detect the presence of artefact
 * files; later slices fill in the worktree / verify probes.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { taskDir } from './state.js';
import type { PhaseSignals, TaskState } from './types.js';

const fileExists = async (path: string): Promise<boolean> => {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
};

/**
 * Derive the current phase signals for a task. Pure-IO function — does
 * not advance phases on its own. The caller (TUI / orchestrator)
 * passes the result into `classifyIntent`.
 *
 * Slice 1 detects:
 *   - `CONTEXT.md` exists  → hasContextDoc
 *   - `PLAN.xml` exists    → hasPlanDoc
 *
 * Slice 3 will fill in `allTasksCommitted` (every worktree branch has
 * commits + has been merged back) and `allVerifyPassed` (every task's
 * `<verify>` exited 0).
 */
export const readSignals = async (state: TaskState): Promise<PhaseSignals> => {
  const dir = taskDir(state.cwd, state.id);
  const contextPath = state.contextDocPath
    ? join(dir, state.contextDocPath)
    : join(dir, 'CONTEXT.md');
  const planPath = state.planDocPath
    ? join(dir, state.planDocPath)
    : join(dir, 'PLAN.xml');
  const [hasContextDoc, hasPlanDoc] = await Promise.all([
    fileExists(contextPath),
    fileExists(planPath)
  ]);
  return {
    hasContextDoc,
    hasPlanDoc,
    allTasksCommitted: false,
    allVerifyPassed: false
  };
};
