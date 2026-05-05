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
import { truncateForLLM } from './truncate.js';
import type { Tool } from './types.js';

const Input = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  cwd: z.string().optional()
});

const MAX_OUT = 64_000;
// Per-stream LLM-facing budget. The full output remains in `data.stdout`/
// `data.stderr` (capped at MAX_OUT) but the `summary` we feed back to the
// model gets head+tail truncated so a single noisy command can't dominate
// the prompt cache.
const MAX_OUT_LLM = 6_000;

export const terminalTool: Tool<z.infer<typeof Input>> = {
  name: 'terminal',
  description: 'Run a shell command. Captures stdout/stderr + exit code. Requires approval.',
  approval: 'ask',
  schema: Input,
  whenToUse:
    'Use for any operation outside file read/write — running tests, installing packages, building, formatting, scaffolding, inspecting processes. Prefer the dedicated `git` / `gh` tools for VCS work (cleaner approval gating).',
  outputContract:
    'On success, `summary` starts with `$ <command>` then `exit: <code>` then optional `stdout:` / `stderr:` blocks (each capped at 64KB, `…(truncated)` appended when over). `data` carries `{exitCode, signal, stdout, stderr}`. Note: a non-zero `exitCode` is still a successful tool result — inspect `exitCode` to decide whether the command itself succeeded.',
  blockedOps: [
    'commands exceeding `timeoutMs` (default 60s, max 600s) are killed and returned as TOOL_EXECUTION_FAILED',
    'rm -rf, force-pushes, dropping data — allowed if user approves but inspect carefully before running',
    'long-running servers / interactive prompts (no stdin connected) — will hang until timeout'
  ],
  examples: [
    {
      input: '{"command":"pnpm test:run"}',
      result: 'runs the test suite, returns exit code + truncated output'
    },
    {
      input: '{"command":"jq .name package.json","timeoutMs":5000}',
      result: 'short utility command with a tight timeout'
    },
    {
      input: '{"command":"npm install","cwd":"packages/cli"}',
      result: 'installs into a sub-package',
      note: 'Use `cwd` to scope without `cd && ...` in the command string.'
    }
  ],
  async execute(input, ctx) {
    return await new Promise((resolvePromise) => {
      const child = spawn(input.command, {
        shell: true,
        cwd: input.cwd ?? ctx.cwd,
        env: process.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const killChild = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          if (process.platform === 'win32') {
            child.kill(signal);
          } else {
            process.kill(-child.pid, signal);
          }
        } catch {
          child.kill(signal);
        }
      };

      const timer = setTimeout(() => {
        killed = true;
        killChild('SIGKILL');
      }, input.timeoutMs);

      const onAbort = (): void => {
        killed = true;
        killChild('SIGTERM');
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
        const llmOut = truncateForLLM(trimmedOut, { maxChars: MAX_OUT_LLM });
        const llmErr = truncateForLLM(trimmedErr, { maxChars: MAX_OUT_LLM });
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
          llmOut.length > 0 ? `stdout:\n${llmOut}` : '(no stdout)',
          llmErr.length > 0 ? `stderr:\n${llmErr}` : ''
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
