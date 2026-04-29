/**
 * Built-in tool: write_file
 *
 * Writes UTF-8 text to a path under the cwd. Approval-gated — never
 * auto-approves in production hosts. Creates parent dirs by default.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { atlasError } from '../errors.js';
import { err, ok } from '../result.js';
import type { Tool } from './types.js';

const Input = z.object({
  path: z.string().min(1),
  content: z.string(),
  createDirs: z.boolean().default(true)
});

export const writeFileTool: Tool<z.infer<typeof Input>> = {
  name: 'write_file',
  description: 'Write a UTF-8 text file under the project cwd. Requires approval.',
  approval: 'ask',
  schema: Input,
  async execute(input, ctx) {
    const abs = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    const rel = relative(ctx.cwd, abs);
    if (rel.startsWith('..')) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `path escapes cwd: ${input.path}`)
      );
    }
    try {
      if (input.createDirs) await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, input.content, 'utf8');
      return ok({
        type: 'ok',
        summary: `wrote ${rel || abs} (${Buffer.byteLength(input.content, 'utf8')} bytes)`,
        data: { path: abs, bytes: Buffer.byteLength(input.content, 'utf8') }
      });
    } catch (e) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `failed to write ${input.path}`, {
          cause: e,
          context: { path: input.path }
        })
      );
    }
  }
};
