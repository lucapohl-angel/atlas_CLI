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
export { phasePromptAddendum } from './phase-prompt.js';
export {
  CONTEXT_FILENAME,
  CONTEXT_DRAFT_FILENAME,
  appendContextEntry,
  finalizeContext,
  readContext,
  type ContextEntry
} from './context.js';
export {
  CONTEXT_SLOTS_FILENAME,
  REQUIRED_SLOTS,
  SLOT_IDS,
  emptySlots,
  formatSlotStatus,
  missingRequiredSlots,
  readSlots,
  renderSlotsMarkdown,
  setSlot,
  type ContextSlots,
  type SlotId
} from './slots.js';
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
export { groupIntoWaves, type Wave } from './waves.js';
export {
  createWorktree,
  commitWorktree,
  removeWorktree,
  type WorktreeHandle,
  type CreateWorktreeOpts
} from './worktree.js';
export {
  executePlan,
  type ExecutorOpts,
  type ExecutionReport,
  type RunTaskFn,
  type RunTaskRequest,
  type RunTaskOutcome,
  type TaskOutcome
} from './executor.js';
