/**
 * Built-in tool: edit_file
 *
 * Surgical, exact-string-match edits to an existing file. Far cheaper
 * than `write_file` for changes to a large file because the model only
 * has to emit the changed regions, not the whole file. Each edit must
 * match the existing content **exactly once** (whitespace included);
 * for genuinely ambiguous matches the model must add more surrounding
 * context until the match is unique.
 *
 * Multiple edits in a single call are applied sequentially — useful
 * for related changes that should land atomically (we still write the
 * file once at the end, so the pre-edit content is the source of truth
 * for every match).
 */
import { readFile, writeFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { atlasError } from '../errors.js';
import { err, ok } from '../result.js';
import type { Tool } from './types.js';

const Edit = z.object({
  oldString: z.string().min(1),
  newString: z.string()
});

const Input = z.object({
  path: z.string().min(1),
  edits: z.array(Edit).min(1).max(50),
  /**
   * When true and the file does not exist, create it with `newString`
   * of the first edit (oldString must be empty). Mostly so the agent
   * can use a single tool for both new files and edits.
   */
  createIfMissing: z.boolean().default(false)
});

const MAX_PATCH_BYTES = 5_000_000;

export const editFileTool: Tool<z.infer<typeof Input>> = {
  name: 'edit_file',
  description:
    'Apply one or more exact-string-match edits to a file. Each edit must match the existing content exactly once. Far cheaper than write_file for changes to large files.',
  approval: 'ask',
  schema: Input,
  whenToUse:
    'Use for any modification to an existing file where you can identify the exact text to replace. Prefer this over write_file when the file is more than ~50 lines, because you only emit the changed regions instead of the entire file. Always read the file first so your `oldString` matches byte-for-byte (whitespace included). For multiple related changes, batch them into a single edit_file call so they land atomically.',
  outputContract:
    'On success, `summary` is `edited <relpath> (N edits, +A/-B chars)`. `data` carries `{path, edits, charsAdded, charsRemoved}`. On failure (no match, multiple matches, file missing) returns a `TOOL_EXECUTION_FAILED` AtlasError that names the failing edit index.',
  blockedOps: [
    'paths that escape cwd via `..` (refused)',
    'oldString that does not appear in the file (refused — read the file first)',
    'oldString that appears more than once (refused — add surrounding context until unique)'
  ],
  examples: [
    {
      input:
        '{"path":"src/foo.ts","edits":[{"oldString":"const N = 1;","newString":"const N = 2;"}]}',
      result: 'changes the constant in place'
    },
    {
      input:
        '{"path":"src/util.ts","edits":[{"oldString":"  return a + b;\\n","newString":"  return a + b + 1;\\n"}]}',
      result: 'edit anchored on the trailing newline + indentation so it matches exactly once'
    }
  ],
  async execute(input, ctx) {
    const abs = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    const rel = relative(ctx.cwd, abs);
    if (rel.startsWith('..')) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `path escapes cwd: ${input.path}`, {
          context: { path: input.path }
        })
      );
    }

    let original: string;
    let exists = true;
    try {
      const s = await stat(abs);
      if (!s.isFile()) {
        return err(
          atlasError('TOOL_EXECUTION_FAILED', `not a file: ${input.path}`, {
            context: { path: input.path }
          })
        );
      }
      if (s.size > MAX_PATCH_BYTES) {
        return err(
          atlasError(
            'TOOL_EXECUTION_FAILED',
            `file too large to patch (${s.size} > ${MAX_PATCH_BYTES} bytes)`,
            { context: { path: input.path, bytes: s.size } }
          )
        );
      }
      original = await readFile(abs, 'utf8');
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') {
        if (!input.createIfMissing) {
          return err(
            atlasError('TOOL_EXECUTION_FAILED', `file not found: ${input.path}`, {
              context: { path: input.path }
            })
          );
        }
        exists = false;
        original = '';
      } else {
        return err(
          atlasError('TOOL_EXECUTION_FAILED', `failed to read ${input.path}`, {
            cause: e,
            context: { path: input.path }
          })
        );
      }
    }

    if (!exists) {
      const first = input.edits[0]!;
      if (first.oldString.length > 0) {
        return err(
          atlasError(
            'TOOL_EXECUTION_FAILED',
            `cannot create ${input.path}: first edit's oldString must be empty when createIfMissing=true`,
            { context: { path: input.path } }
          )
        );
      }
      original = first.newString;
      // Any further edits apply to the just-created content.
    }

    let current = original;
    let editsApplied = 0;
    const startIdx = exists ? 0 : 1;
    for (let i = startIdx; i < input.edits.length; i += 1) {
      const e = input.edits[i]!;
      const occurrences = countOccurrences(current, e.oldString);
      if (occurrences === 0) {
        return err(
          atlasError(
            'TOOL_EXECUTION_FAILED',
            `edit #${i + 1}: oldString not found in ${input.path}. Read the file again and supply the exact text.`,
            { context: { path: input.path, editIndex: i } }
          )
        );
      }
      if (occurrences > 1) {
        return err(
          atlasError(
            'TOOL_EXECUTION_FAILED',
            `edit #${i + 1}: oldString matches ${occurrences} places in ${input.path}. Add more surrounding context until it is unique.`,
            { context: { path: input.path, editIndex: i, occurrences } }
          )
        );
      }
      current = current.replace(e.oldString, e.newString);
      editsApplied += 1;
    }

    if (!exists) editsApplied += 1; // count the creation as one applied edit

    try {
      await writeFile(abs, current, 'utf8');
    } catch (e) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `failed to write ${input.path}`, {
          cause: e,
          context: { path: input.path }
        })
      );
    }

    const before = Buffer.byteLength(original, 'utf8');
    const after = Buffer.byteLength(current, 'utf8');
    const delta = after - before;
    const sign = delta >= 0 ? '+' : '';
    return ok({
      type: 'ok',
      summary: `edited ${rel || abs} (${editsApplied} edit${editsApplied === 1 ? '' : 's'}, ${sign}${delta} bytes)`,
      data: {
        path: abs,
        edits: editsApplied,
        bytesBefore: before,
        bytesAfter: after,
        delta
      }
    });
  }
};

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
