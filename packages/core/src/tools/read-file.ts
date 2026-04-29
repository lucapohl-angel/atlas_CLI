/**
 * Built-in tool: read_file
 *
 * Reads up to `maxBytes` of a UTF-8 file. Path is resolved against the
 * tool context's cwd. Refuses to escape the cwd via `..` for safety.
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { atlasError } from '../errors.js';
import { ok, err } from '../result.js';
import type { Tool } from './types.js';

const Input = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(10_000_000).default(200_000)
});

const MAX_PREVIEW = 4_000;

export const readFileTool: Tool<z.infer<typeof Input>> = {
  name: 'read_file',
  description: 'Read a UTF-8 text file from the project. Path is relative to cwd.',
  approval: 'auto',
  schema: Input,
  async execute(input, ctx) {
    const abs = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    const rel = relative(ctx.cwd, abs);
    if (rel.startsWith('..')) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `path escapes cwd: ${input.path}`, {
          context: { path: input.path, cwd: ctx.cwd }
        })
      );
    }
    try {
      const stats = await stat(abs);
      if (!stats.isFile()) {
        return err(
          atlasError('TOOL_EXECUTION_FAILED', `not a file: ${input.path}`, {
            context: { path: input.path }
          })
        );
      }
      const buf = await readFile(abs);
      const truncated = buf.byteLength > input.maxBytes;
      const text = buf.subarray(0, input.maxBytes).toString('utf8');
      const preview = text.length > MAX_PREVIEW ? text.slice(0, MAX_PREVIEW) + '\n…(truncated)' : text;
      return ok({
        type: 'ok',
        summary: `read ${rel || abs} (${buf.byteLength} bytes${truncated ? ', truncated' : ''})\n\n${preview}`,
        data: { path: abs, bytes: buf.byteLength, truncated, content: text }
      });
    } catch (e) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `failed to read ${input.path}`, {
          cause: e,
          context: { path: input.path }
        })
      );
    }
  }
};
