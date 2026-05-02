import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
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
import { webFetchTool } from './web-fetch.js';
import { webSearchTool } from './web-search.js';
import { ToolRegistry } from './registry.js';

export * from './types.js';
export * from './registry.js';
export * from './todo-store.js';
export * from './html-to-text.js';
export { readFileTool } from './read-file.js';
export { writeFileTool } from './write-file.js';
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
export { webFetchTool } from './web-fetch.js';
export { webSearchTool } from './web-search.js';

/** Returns a fresh registry pre-populated with the built-in tools. */
export const builtinToolRegistry = (): ToolRegistry => {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(writeFileTool);
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
  r.register(webFetchTool);
  r.register(webSearchTool);
  return r;
};
