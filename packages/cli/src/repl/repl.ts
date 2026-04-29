/**
 * Atlas REPL — interactive multi-turn loop.
 *
 * Phase 2: readline-based prompt with conversation history, slash commands
 * (`/exit`, `/clear`, `/help`, `/model <id>`), and Ctrl-C mid-stream
 * cancellation that does NOT exit the REPL.
 *
 * (An Ink TUI is a future polish concern; the contract is "interactive
 * REPL with cancellation", which readline meets without 5k LOC of UI.)
 */
import { createInterface, type Interface } from 'node:readline';
import {
  loadConfig,
  providerFromConfig,
  type AtlasConfig,
  type Message,
  type Provider
} from '@atlas/core';

export interface ReplDeps {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
  /** Inject a Provider directly. If absent, we load from config. */
  readonly provider?: Provider;
  /** Inject the model name to use when `provider` is also injected. */
  readonly model?: string;
  /** Inject conversation history (tests). */
  readonly history?: Message[];
  /** Suppress the welcome banner (tests). */
  readonly quiet?: boolean;
}

export interface ReplResult {
  readonly exitCode: number;
  /** Final conversation, exposed for tests. */
  readonly history: readonly Message[];
}

const HELP = [
  '',
  'Commands:',
  '  /help            show this help',
  '  /clear           clear conversation history',
  '  /model <id>      switch the active model',
  '  /history         print the current conversation',
  '  /exit, /quit     leave the REPL (Ctrl-D also works)',
  ''
].join('\n');

export const runRepl = async (deps: ReplDeps = {}): Promise<ReplResult> => {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;

  let provider: Provider;
  let model: string;
  let cfg: AtlasConfig | null = null;

  if (deps.provider) {
    provider = deps.provider;
    model = deps.model ?? 'anthropic/claude-sonnet-4';
  } else {
    const cfgResult = await loadConfig({ env });
    if (!cfgResult.ok) {
      stderr.write(`atlas: ${cfgResult.error.message}\n`);
      return { exitCode: 1, history: [] };
    }
    cfg = cfgResult.value;
    const provResult = providerFromConfig(cfg);
    if (!provResult.ok) {
      stderr.write(`atlas: ${provResult.error.message}\n`);
      return { exitCode: 1, history: [] };
    }
    provider = provResult.value;
    model = deps.model ?? cfg.defaultModel;
  }

  const history: Message[] = deps.history ? [...deps.history] : [];

  if (!deps.quiet) {
    stdout.write(`atlas — interactive REPL\n`);
    stdout.write(`model: ${model}    type /help for commands, /exit to leave\n\n`);
  }

  const rl: Interface = createInterface({
    input: stdin,
    output: stdout,
    terminal: false,
    prompt: '> '
  });
  rl.setPrompt('> ');
  // Safely re-prompt: readline throws if the stream has already closed
  // (common in non-interactive runs where stdin ends with the input).
  let rlClosed = false;
  rl.once('close', () => {
    rlClosed = true;
  });
  const safePrompt = (): void => {
    if (!rlClosed) {
      try {
        rl.prompt();
      } catch {
        rlClosed = true;
      }
    }
  };
  safePrompt();

  /** AbortController for the in-flight stream (if any). */
  let activeAbort: AbortController | null = null;

  // Ctrl-C: cancel current generation, but don't exit the REPL.
  const onSigint = (): void => {
    if (activeAbort) {
      activeAbort.abort();
    } else {
      stdout.write('\n(use /exit or Ctrl-D to leave)\n');
      safePrompt();
    }
  };
  process.on('SIGINT', onSigint);

  let exitCode = 0;

  try {
    for await (const rawLine of rl as unknown as AsyncIterable<string>) {
      const line = rawLine.trim();
      if (line.length === 0) {
        safePrompt();
        continue;
      }

      if (line.startsWith('/')) {
        const result = handleSlash(line, {
          stdout,
          stderr,
          history,
          setModel: (m) => {
            model = m;
            stdout.write(`model: ${model}\n`);
          }
        });
        if (result === 'exit') break;
        safePrompt();
        continue;
      }

      history.push({ role: 'user', content: line });

      activeAbort = new AbortController();
      const fallbackModels = cfg?.fallbackModels ?? [];
      const stream = provider.stream({
        model,
        ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
        messages: history,
        signal: activeAbort.signal
      });

      let assistant = '';
      let cancelled = false;
      try {
        for await (const event of stream) {
          if (event.type === 'delta') {
            assistant += event.text;
            stdout.write(event.text);
          } else if (event.type === 'done') {
            stdout.write('\n');
            break;
          } else if (event.type === 'error') {
            if (event.error.code === 'CANCELLED') {
              cancelled = true;
              stdout.write('\n(cancelled)\n');
            } else {
              stdout.write('\n');
              stderr.write(`atlas: [${event.error.code}] ${event.error.message}\n`);
            }
            break;
          }
        }
      } finally {
        activeAbort = null;
      }

      if (assistant.length > 0 && !cancelled) {
        history.push({ role: 'assistant', content: assistant });
      } else if (cancelled) {
        // Drop the unanswered user turn so the next request stays coherent.
        history.pop();
      }

      safePrompt();
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    rl.close();
  }

  return { exitCode, history };
};

interface SlashCtx {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly history: Message[];
  readonly setModel: (m: string) => void;
}

const handleSlash = (line: string, ctx: SlashCtx): 'exit' | 'continue' => {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  switch (cmd) {
    case 'exit':
    case 'quit':
      return 'exit';
    case 'help':
      ctx.stdout.write(HELP);
      return 'continue';
    case 'clear':
      ctx.history.length = 0;
      ctx.stdout.write('(history cleared)\n');
      return 'continue';
    case 'history':
      if (ctx.history.length === 0) ctx.stdout.write('(empty)\n');
      for (const m of ctx.history) ctx.stdout.write(`[${m.role}] ${m.content}\n`);
      return 'continue';
    case 'model': {
      const id = rest.join(' ').trim();
      if (id.length === 0) {
        ctx.stderr.write('usage: /model <id>\n');
      } else {
        ctx.setModel(id);
      }
      return 'continue';
    }
    default:
      ctx.stderr.write(`unknown command: /${cmd ?? ''}\n`);
      return 'continue';
  }
};
