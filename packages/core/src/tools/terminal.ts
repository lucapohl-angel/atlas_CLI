/**
 * Built-in tool: terminal
 *
 * Runs a single shell command, captures stdout/stderr, returns trimmed
 * output and the exit code. Always approval-gated. Cancellable via
 * AbortSignal — kills the child process group if abort fires.
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { atlasError } from '../errors.js';
import { err, ok } from '../result.js';
import type { Tool } from './types.js';

const Input = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  cwd: z.string().optional()
});

const MAX_OUT = 64_000;

export const terminalTool: Tool<z.infer<typeof Input>> = {
  name: 'terminal',
  description: 'Run a shell command. Captures stdout/stderr + exit code. Requires approval.',
  approval: 'ask',
  schema: Input,
  async execute(input, ctx) {
    return await new Promise((resolvePromise) => {
      const child = spawn(input.command, {
        shell: true,
        cwd: input.cwd ?? ctx.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, input.timeoutMs);

      const onAbort = (): void => {
        killed = true;
        child.kill('SIGTERM');
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (c: Buffer) => {
        if (stdout.length < MAX_OUT) stdout += c.toString('utf8');
      });
      child.stderr.on('data', (c: Buffer) => {
        if (stderr.length < MAX_OUT) stderr += c.toString('utf8');
      });

      child.on('error', (e) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        resolvePromise(
          err(
            atlasError('TOOL_EXECUTION_FAILED', `failed to spawn shell: ${e.message}`, {
              cause: e
            })
          )
        );
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        const trimmedOut = stdout.length > MAX_OUT ? stdout.slice(0, MAX_OUT) + '\n…(truncated)' : stdout;
        const trimmedErr = stderr.length > MAX_OUT ? stderr.slice(0, MAX_OUT) + '\n…(truncated)' : stderr;
        if (killed && ctx.signal?.aborted) {
          resolvePromise(err(atlasError('TOOL_CANCELLED', 'terminal command cancelled')));
          return;
        }
        if (killed) {
          resolvePromise(
            err(
              atlasError('TOOL_EXECUTION_FAILED', `command exceeded timeout (${input.timeoutMs}ms)`, {
                context: { command: input.command }
              })
            )
          );
          return;
        }
        const summary = [
          `$ ${input.command}`,
          `exit: ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`,
          trimmedOut.length > 0 ? `stdout:\n${trimmedOut}` : '(no stdout)',
          trimmedErr.length > 0 ? `stderr:\n${trimmedErr}` : ''
        ]
          .filter((s) => s.length > 0)
          .join('\n');
        resolvePromise(
          ok({
            type: 'ok',
            summary,
            data: { exitCode: code, signal, stdout: trimmedOut, stderr: trimmedErr }
          })
        );
      });
    });
  }
};
