/**
 * Workflow / phase router — public surface.
 *
 * Slice 1 ships the state machine, on-disk persistence, and rule-based
 * classifier. Slices 2 & 3 add CONTEXT.md generation, XML plans,
 * worktree-isolated execution, and verify loops on top of these
 * primitives — without changing any of the exported types here.
 */
export * from './types.js';
export {
  classifyIntent,
  canRewindTo,
  formatPhaseLine
} from './router.js';
export {
  loadActiveTask,
  loadCurrentTaskPointer,
  loadTaskState,
  saveCurrentTaskPointer,
  saveTaskState,
  startTask,
  updateTask,
  clearActiveTask,
  newTaskId,
  titleFromMessage,
  taskDir,
  taskStatePath,
  tasksRoot,
  currentTaskPointerPath,
  type StartTaskOpts,
  type UpdateTaskPatch
} from './state.js';
export { readSignals } from './signals.js';
export {
  CONTEXT_FILENAME,
  CONTEXT_DRAFT_FILENAME,
  appendContextEntry,
  finalizeContext,
  readContext,
  type ContextEntry
} from './context.js';
export {
  PLAN_FILENAME,
  serializePlan,
  parsePlan,
  checkPlan,
  writePlan,
  readPlan,
  type Plan,
  type PlanTask,
  type PlanIssue
} from './plan.js';
