import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { editFileTool } from './edit-file.js';
import { terminalTool } from './terminal.js';
import { gitTool, ghTool } from './vcs.js';
import {
  storyCreateTool,
  storyUpdateTool,
  handoffEmitTool,
  handoffConsumeTool
} from './stories.js';
import { templateRenderTool, templateListTool } from './templates.js';
import { checklistRunTool, checklistListTool } from './checklists.js';
import { todoTool } from './todo.js';
import { clarifyTool } from './clarify.js';
import { openQuestionTool } from './open-question.js';
import { webFetchTool } from './web-fetch.js';
import { webSearchTool } from './web-search.js';
import { browserTool } from './browser/index.js';
import { delegateTool } from './delegate.js';
import {
  contextNoteTool,
  contextShowTool,
  contextSetTool,
  contextStatusTool,
  contextFinalizeTool,
  planWriteTool,
  planShowTool,
  planCheckTool,
  planExecuteTool,
  shipSummaryTool,
  shipApplyTool
} from './workflow.js';
import { ToolRegistry } from './registry.js';

export * from './types.js';
export * from './registry.js';
export * from './todo-store.js';
export * from './html-to-text.js';
export * from './searxng-manager.js';
export * from './catalog.js';
export { readFileTool } from './read-file.js';
export { writeFileTool } from './write-file.js';
export { editFileTool } from './edit-file.js';
export { terminalTool } from './terminal.js';
export { gitTool, ghTool } from './vcs.js';
export {
  storyCreateTool,
  storyUpdateTool,
  handoffEmitTool,
  handoffConsumeTool
} from './stories.js';
export { templateRenderTool, templateListTool } from './templates.js';
export { checklistRunTool, checklistListTool } from './checklists.js';
export { todoTool } from './todo.js';
export { clarifyTool } from './clarify.js';
export { openQuestionTool } from './open-question.js';
export { webFetchTool } from './web-fetch.js';
export { webSearchTool } from './web-search.js';
export { browserTool } from './browser/index.js';
export { closeBrowser, browserAvailable } from './browser/session.js';
export { delegateTool } from './delegate.js';
export { createDelegateRunner } from './delegate-runner.js';
export type { CreateDelegateRunnerOptions } from './delegate-runner.js';
export {
  contextNoteTool,
  contextShowTool,
  contextSetTool,
  contextStatusTool,
  contextFinalizeTool,
  planWriteTool,
  planShowTool,
  planCheckTool,
  planExecuteTool,
  shipSummaryTool,
  shipApplyTool
} from './workflow.js';

/** Returns a fresh registry pre-populated with the built-in tools. */
export const builtinToolRegistry = (): ToolRegistry => {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(writeFileTool);
  r.register(editFileTool);
  r.register(terminalTool);
  r.register(gitTool);
  r.register(ghTool);
  r.register(storyCreateTool);
  r.register(storyUpdateTool);
  r.register(handoffEmitTool);
  r.register(handoffConsumeTool);
  r.register(templateRenderTool);
  r.register(templateListTool);
  r.register(checklistRunTool);
  r.register(checklistListTool);
  r.register(todoTool);
  r.register(clarifyTool);
  r.register(openQuestionTool);
  r.register(webFetchTool);
  r.register(webSearchTool);
  r.register(browserTool);
  r.register(delegateTool);
  r.register(contextNoteTool);
  r.register(contextShowTool);
  r.register(contextSetTool);
  r.register(contextStatusTool);
  r.register(contextFinalizeTool);
  r.register(planWriteTool);
  r.register(planShowTool);
  r.register(planCheckTool);
  r.register(planExecuteTool);
  r.register(shipSummaryTool);
  r.register(shipApplyTool);
  return r;
};
