import { z } from 'zod';
import { atlasError } from '@atlas/core/errors';
import { err, ok } from '@atlas/core/result';
import type { Tool } from '@atlas/core/tools/types';
import {
  isMissingFileError,
  isRegularFile,
  resolveWorkspacePath,
  type TextDocumentLike,
  type VsCodeToolHost,
} from './types.js';

const Edit = z.object({
  oldString: z.string(),
  newString: z.string(),
});

const Input = z.object({
  path: z.string().min(1),
  edits: z.array(Edit).min(1).max(50),
  createIfMissing: z.boolean().default(false),
});

const MAX_PATCH_BYTES = 5_000_000;

export const createVsCodeEditFileTool = (
  host: VsCodeToolHost,
): Tool<z.infer<typeof Input>> => ({
  name: 'edit_file',
  description:
    'Apply one or more exact-string-match edits through VS Code WorkspaceEdit. Each edit must match the existing content exactly once. Requires approval.',
  approval: 'ask',
  schema: Input,
  whenToUse:
    'Use for modifications to an existing file where you can identify the exact text to replace. This VS Code host adapter reads unsaved editor state and applies edits via WorkspaceEdit so changes participate in VS Code undo/diff workflows.',
  outputContract:
    'On success, `summary` is `edited <relpath> (N edits, +A/-B bytes)`. `data` carries `{path, edits, bytesBefore, bytesAfter, delta}`. On failure returns a `TOOL_EXECUTION_FAILED` AtlasError that names the failing edit index.',
  blockedOps: [
    'paths that escape cwd via `..` (refused)',
    'oldString that does not appear in the file (refused — read the file first)',
    'oldString that appears more than once (refused — add surrounding context until unique)',
  ],
  examples: [
    { input: '{"path":"src/foo.ts","edits":[{"oldString":"const N = 1;","newString":"const N = 2;"}]}', result: 'changes the constant in place' },
    { input: '{"path":"src/util.ts","edits":[{"oldString":"  return a + b;\\n","newString":"  return a + b + 1;\\n"}]}', result: 'edit anchored on the trailing newline + indentation so it matches exactly once' },
  ],
  async execute(input, ctx) {
    const resolved = resolveWorkspacePath(ctx.cwd, input.path);
    if (!resolved.ok) return err(resolved.error);
    const uri = host.Uri.file(resolved.value.abs);

    let original: string;
    let document: TextDocumentLike | null = null;
    let exists = true;
    try {
      const stat = await host.workspace.fs.stat(uri);
      if (!isRegularFile(host, stat)) {
        return err(atlasError('TOOL_EXECUTION_FAILED', `not a file: ${input.path}`, {
          context: { path: input.path },
        }));
      }
      document = await host.workspace.openTextDocument(uri);
      original = document.getText();
      const size = Buffer.byteLength(original, 'utf8');
      if (size > MAX_PATCH_BYTES) {
        return err(atlasError('TOOL_EXECUTION_FAILED', `file too large to patch (${size} > ${MAX_PATCH_BYTES} bytes)`, {
          context: { path: input.path, bytes: size },
        }));
      }
    } catch (error) {
      if (!isMissingFileError(error) || !input.createIfMissing) {
        return err(atlasError('TOOL_EXECUTION_FAILED', `failed to read ${input.path}`, {
          cause: error,
          context: { path: input.path },
        }));
      }
      exists = false;
      original = '';
    }

    if (!exists) {
      const first = input.edits[0]!;
      if (first.oldString.length > 0) {
        return err(atlasError(
          'TOOL_EXECUTION_FAILED',
          `cannot create ${input.path}: first edit's oldString must be empty when createIfMissing=true`,
          { context: { path: input.path } },
        ));
      }
      original = first.newString;
    }

    let current = original;
    let editsApplied = exists ? 0 : 1;
    const startIdx = exists ? 0 : 1;
    for (let index = startIdx; index < input.edits.length; index += 1) {
      const edit = input.edits[index]!;
      if (edit.oldString.length === 0) {
        return err(atlasError('TOOL_EXECUTION_FAILED', `edit #${index + 1}: oldString must not be empty`, {
          context: { path: input.path, editIndex: index },
        }));
      }
      const occurrences = countOccurrences(current, edit.oldString);
      if (occurrences === 0) {
        return err(atlasError(
          'TOOL_EXECUTION_FAILED',
          `edit #${index + 1}: oldString not found in ${input.path}. Read the file again and supply the exact text.`,
          { context: { path: input.path, editIndex: index } },
        ));
      }
      if (occurrences > 1) {
        return err(atlasError(
          'TOOL_EXECUTION_FAILED',
          `edit #${index + 1}: oldString matches ${occurrences} places in ${input.path}. Add more surrounding context until it is unique.`,
          { context: { path: input.path, editIndex: index, occurrences } },
        ));
      }
      current = current.replace(edit.oldString, edit.newString);
      editsApplied += 1;
    }

    const workspaceEdit = new host.WorkspaceEdit();
    if (exists) {
      if (!document) {
        return err(atlasError('INTERNAL', `document was not loaded for ${input.path}`));
      }
      const fullRange = new host.Range(document.positionAt(0), document.positionAt(original.length));
      workspaceEdit.replace(uri, fullRange, current);
    } else {
      workspaceEdit.createFile(uri, { contents: new TextEncoder().encode(current) });
    }

    const applied = await host.workspace.applyEdit(workspaceEdit);
    if (!applied) {
      return err(atlasError('TOOL_EXECUTION_FAILED', `VS Code rejected edit for ${input.path}`, {
        context: { path: input.path },
      }));
    }

    const before = Buffer.byteLength(original, 'utf8');
    const after = Buffer.byteLength(current, 'utf8');
    const delta = after - before;
    const sign = delta >= 0 ? '+' : '';
    return ok({
      type: 'ok',
      summary: `edited ${resolved.value.rel || resolved.value.abs} (${editsApplied} edit${editsApplied === 1 ? '' : 's'}, ${sign}${delta} bytes)`,
      data: { path: resolved.value.abs, edits: editsApplied, bytesBefore: before, bytesAfter: after, delta },
    });
  },
});

const countOccurrences = (haystack: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return count;
    count += 1;
    from = idx + needle.length;
  }
};
