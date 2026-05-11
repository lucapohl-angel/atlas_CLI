import { dirname } from 'node:path';
import { z } from 'zod';
import { atlasError } from '@atlas/core/errors';
import { err, ok } from '@atlas/core/result';
import type { Tool } from '@atlas/core/tools/types';
import {
  isRegularFile,
  resolveWorkspacePath,
  truncateForPreview,
  type VsCodeToolHost,
} from './types.js';

const ReadInput = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(10_000_000).default(200_000),
});


const WriteInput = z.object({
  path: z.string().min(1),
  content: z.string(),
  createDirs: z.boolean().default(true),
});

const MAX_PREVIEW = 8_000;

export const createVsCodeReadFileTool = (
  host: VsCodeToolHost,
): Tool<z.infer<typeof ReadInput>> => ({
  name: 'read_file',
  description: 'Read a UTF-8 text file from the VS Code workspace. Path is relative to cwd.',
  approval: 'auto',
  schema: ReadInput,
  whenToUse:
    'Whenever you need to look at the actual contents of a source file, config, README, or test before reasoning about it. This VS Code host adapter reads through openTextDocument so unsaved editor changes are visible to Atlas.',
  outputContract:
    'On success, `summary` starts with `read <relpath> (<bytes> bytes[, truncated])` followed by a blank line and the file content preview. `data.content` carries the full UTF-8 text up to `maxBytes`.',
  blockedOps: [
    'paths that escape cwd via `..` (refused)',
    'files larger than `maxBytes` (truncated, never errored)',
  ],
  examples: [
    { input: '{"path":"package.json"}', result: 'returns the file contents, including unsaved editor changes' },
    { input: '{"path":"src/big.log","maxBytes":50000}', result: 'reads the first 50000 bytes of a large file' },
  ],
  async execute(input, ctx) {
    const resolved = resolveWorkspacePath(ctx.cwd, input.path);
    if (!resolved.ok) return err(resolved.error);
    const uri = host.Uri.file(resolved.value.abs);

    try {
      const stat = await host.workspace.fs.stat(uri);
      if (!isRegularFile(host, stat)) {
        return err(atlasError('TOOL_EXECUTION_FAILED', `not a file: ${input.path}`, {
          context: { path: input.path },
        }));
      }

      const document = await host.workspace.openTextDocument(uri);
      const fullText = document.getText();
      const bytes = Buffer.from(fullText, 'utf8');
      const truncated = bytes.byteLength > input.maxBytes;
      const content = bytes.subarray(0, input.maxBytes).toString('utf8');
      const preview = truncateForPreview(content, MAX_PREVIEW);
      const summary = `read ${resolved.value.rel || resolved.value.abs} (${bytes.byteLength} bytes${truncated ? ', truncated' : ''})\n\n${preview}`;
      return ok({
        type: 'ok',
        summary,
        data: { path: resolved.value.abs, bytes: bytes.byteLength, truncated, content },
      });
    } catch (error) {
      return err(atlasError('TOOL_EXECUTION_FAILED', `failed to read ${input.path}`, {
        cause: error,
        context: { path: input.path },
      }));
    }
  },
});

export const createVsCodeWriteFileTool = (
  host: VsCodeToolHost,
): Tool<z.infer<typeof WriteInput>> => ({
  name: 'write_file',
  description: 'Write a UTF-8 text file through VS Code workspace.fs. Requires approval.',
  approval: 'ask',
  schema: WriteInput,
  whenToUse:
    'Use to create a new file or to wholesale-replace an existing one. In the VS Code host this writes through workspace.fs so workspace providers and remote hosts are respected.',
  outputContract:
    'On success, `summary` is `wrote <relpath> (<bytes> bytes)`. `data` carries `{path, bytes}`. Failure returns a `TOOL_EXECUTION_FAILED` AtlasError.',
  blockedOps: [
    'paths that escape cwd via `..` (refused)',
    'paths outside the project root (refused unless absolute matches cwd)',
  ],
  examples: [
    { input: '{"path":"docs/prd.md","content":"# PRD\\n\\n..."}', result: 'creates docs/ if missing then writes prd.md' },
    { input: '{"path":"src/foo.ts","content":"export const x = 1;\\n","createDirs":false}', result: 'fails if src/ does not already exist' },
  ],
  async execute(input, ctx) {
    const resolved = resolveWorkspacePath(ctx.cwd, input.path);
    if (!resolved.ok) return err(resolved.error);
    const uri = host.Uri.file(resolved.value.abs);
    const content = new TextEncoder().encode(input.content);

    try {
      if (input.createDirs) await host.workspace.fs.createDirectory(host.Uri.file(dirname(resolved.value.abs)));
      await host.workspace.fs.writeFile(uri, content);
      return ok({
        type: 'ok',
        summary: `wrote ${resolved.value.rel || resolved.value.abs} (${content.byteLength} bytes)`,
        data: { path: resolved.value.abs, bytes: content.byteLength },
      });
    } catch (error) {
      return err(atlasError('TOOL_EXECUTION_FAILED', `failed to write ${input.path}`, {
        cause: error,
        context: { path: input.path },
      }));
    }
  },
});