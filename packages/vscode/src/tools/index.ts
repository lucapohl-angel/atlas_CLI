import { builtinToolRegistry } from '@atlas/core/tools';
import type { ToolRegistry } from '@atlas/core/tools/registry';
import type { VsCodeToolHost } from './types.js';
import { createVsCodeEditFileTool } from './vscode-edit.js';
import { createVsCodeReadFileTool, createVsCodeWriteFileTool } from './vscode-fs.js';
import { createVsCodeTerminalTool } from './vscode-terminal.js';

export { createVsCodeApprovalPolicy, createVsCodeClarifyAsk } from './approval.js';
export type { VsCodeToolHost } from './types.js';

export const createVsCodeToolRegistry = (host: VsCodeToolHost): ToolRegistry => {
  const registry = builtinToolRegistry();
  for (const name of ['read_file', 'write_file', 'edit_file', 'terminal']) {
    registry.unregister(name);
  }
  registry.register(createVsCodeReadFileTool(host));
  registry.register(createVsCodeWriteFileTool(host));
  registry.register(createVsCodeEditFileTool(host));
  registry.register(createVsCodeTerminalTool(host));
  return registry;
};
