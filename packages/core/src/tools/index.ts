import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { terminalTool } from './terminal.js';
import { gitTool, ghTool } from './vcs.js';
import { ToolRegistry } from './registry.js';

export * from './types.js';
export * from './registry.js';
export { readFileTool } from './read-file.js';
export { writeFileTool } from './write-file.js';
export { terminalTool } from './terminal.js';
export { gitTool, ghTool } from './vcs.js';

/** Returns a fresh registry pre-populated with the built-in tools. */
export const builtinToolRegistry = (): ToolRegistry => {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(writeFileTool);
  r.register(terminalTool);
  r.register(gitTool);
  r.register(ghTool);
  return r;
};
