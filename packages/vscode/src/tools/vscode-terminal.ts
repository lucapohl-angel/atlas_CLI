import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { atlasError } from '@atlas/core/errors';
import { err, ok } from '@atlas/core/result';
import type { Tool } from '@atlas/core/tools/types';
import { truncateForPreview, type VsCodeToolHost } from './types.js';

const Input = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  cwd: z.string().optional(),
});

const MAX_OUT = 64_000;
const MAX_OUT_LLM = 6_000;

export const createVsCodeTerminalTool = (
  host: VsCodeToolHost,
): Tool<z.infer<typeof Input>> => ({
  name: 'terminal',
  description: 'Run a shell command in a VS Code Pseudoterminal. Captures stdout/stderr + exit code. Requires approval.',
  approval: 'ask',
  schema: Input,
  whenToUse:
    'Use for operations outside file read/write — running tests, installing packages, building, formatting, scaffolding, inspecting processes. In the VS Code host, output is also mirrored to an Atlas terminal panel.',
  outputContract:
    'On success, `summary` starts with `$ <command>` then `exit: <code>` then optional `stdout:` / `stderr:` blocks. `data` carries `{exitCode, signal, stdout, stderr}`. A non-zero exit code is still a successful tool result.',
  blockedOps: [
    'commands exceeding `timeoutMs` (default 60s, max 600s) are killed and returned as TOOL_EXECUTION_FAILED',
    'rm -rf, force-pushes, dropping data — allowed if user approves but inspect carefully before running',
    'long-running servers / interactive prompts (no stdin connected) — will hang until timeout',
  ],
  examples: [
    { input: '{"command":"pnpm test:run"}', result: 'runs the test suite, returns exit code + truncated output' },
    { input: '{"command":"jq .name package.json","timeoutMs":5000}', result: 'short utility command with a tight timeout' },
    { input: '{"command":"npm install","cwd":"packages/cli"}', result: 'installs into a sub-package' },
  ],
  async execute(input, ctx) {
    if (ctx.signal?.aborted) return err(atlasError('TOOL_CANCELLED', 'terminal command cancelled'));
    const commandCwd = input.cwd
      ? isAbsolute(input.cwd) ? input.cwd : resolve(ctx.cwd, input.cwd)
      : ctx.cwd;

    return await new Promise((resolvePromise) => {
      let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
      let stdout = '';
      let stderr = '';
      let killed = false;
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const writeEmitter = new host.EventEmitter<string>();
      const closeEmitter = new host.EventEmitter<number | void>();

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        writeEmitter.dispose();
        closeEmitter.dispose();
      };

      const killChild = (signal: NodeJS.Signals): void => {
        if (!child || child.pid === undefined) return;
        try {
          if (process.platform === 'win32') child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      };

      const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        closeEmitter.fire(exitCode ?? undefined);
        cleanup();
        if (killed && ctx.signal?.aborted) {
          resolvePromise(err(atlasError('TOOL_CANCELLED', 'terminal command cancelled')));
          return;
        }
        if (killed) {
          resolvePromise(err(atlasError('TOOL_EXECUTION_FAILED', `command exceeded timeout (${input.timeoutMs}ms)`, {
            context: { command: input.command },
          })));
          return;
        }
        const trimmedOut = stdout.length > MAX_OUT ? `${stdout.slice(0, MAX_OUT)}\n...(truncated)` : stdout;
        const trimmedErr = stderr.length > MAX_OUT ? `${stderr.slice(0, MAX_OUT)}\n...(truncated)` : stderr;
        const llmOut = truncateForPreview(trimmedOut, MAX_OUT_LLM);
        const llmErr = truncateForPreview(trimmedErr, MAX_OUT_LLM);
        const summary = [
          `$ ${input.command}`,
          `exit: ${exitCode ?? 'null'}${signal ? ` (signal ${signal})` : ''}`,
          llmOut.length > 0 ? `stdout:\n${llmOut}` : '(no stdout)',
          llmErr.length > 0 ? `stderr:\n${llmErr}` : '',
        ].filter((line) => line.length > 0).join('\n');
        resolvePromise(ok({
          type: 'ok',
          summary,
          data: { exitCode, signal, stdout: trimmedOut, stderr: trimmedErr },
        }));
      };

      const onAbort = (): void => {
        killed = true;
        killChild('SIGTERM');
      };

      const start = (): void => {
        writeEmitter.fire(`$ ${input.command}\r\n`);
        const spawned = spawn(input.command, {
          shell: true,
          cwd: commandCwd,
          env: process.env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child = spawned;

        timer = setTimeout(() => {
          killed = true;
          killChild('SIGKILL');
        }, input.timeoutMs);
        ctx.signal?.addEventListener('abort', onAbort, { once: true });

        spawned.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (stdout.length < MAX_OUT) stdout += text;
          writeEmitter.fire(toTerminalText(text));
        });
        spawned.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (stderr.length < MAX_OUT) stderr += text;
          writeEmitter.fire(toTerminalText(text));
        });
        spawned.on('error', (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolvePromise(err(atlasError('TOOL_EXECUTION_FAILED', `failed to spawn shell: ${error.message}`, {
            cause: error,
          })));
        });
        spawned.on('close', (code, signal) => settle(code, signal));
      };

      const terminal = host.window.createTerminal({
        name: terminalName(input.command),
        pty: {
          onDidWrite: writeEmitter.event,
          onDidClose: closeEmitter.event,
          open: () => start(),
          close: () => {
            killed = true;
            killChild('SIGTERM');
          },
        },
        isTransient: true,
      });
      terminal.show(true);
    });
  },
});

const terminalName = (command: string): string => {
  const compact = command.replace(/\s+/g, ' ').trim();
  return `Atlas: ${compact.slice(0, 48)}`;
};

const toTerminalText = (text: string): string => text.replace(/\n/g, '\r\n');
