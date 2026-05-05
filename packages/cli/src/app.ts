/**
 * Atlas CLI application bootstrap.
 *
 * Phase 1: `atlas ask "<prompt>"` streams a single-turn answer from the
 * configured provider. Subsequent phases add the REPL, tools, hooks, etc.
 */
import { Command } from 'commander';
import { ATLAS_VERSION, childLogger } from '@atlas/core';
import { runAsk } from './commands/ask.js';
import { runInit } from './commands/init.js';
import { runStatus } from './commands/status.js';
import { runSearxng } from './commands/searxng.js';
import { runVscodeSetup } from './commands/vscode-setup.js';
import { runRepl } from './repl/repl.js';
import { runTui } from './tui/runTui.js';

const log = childLogger('cli');

export const buildProgram = (): Command => {
  const program = new Command();

  program
    .name('atlas')
    .description('Atlas CLI — autonomous development crew (Greek god agents + skills + hooks)')
    .version(ATLAS_VERSION, '-v, --version', 'show version and exit')
    .helpOption('-h, --help', 'show this help and exit');

  program
    .command('doctor')
    .description('print runtime + environment diagnostics')
    .action(() => {
      const out = {
        atlas: ATLAS_VERSION,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        cwd: process.cwd()
      };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    });

  program
    .command('ask')
    .description('ask the configured model a single question and stream the reply')
    .argument('<prompt...>', 'the question to ask (joined by spaces)')
    .option('-m, --model <id>', 'override the default model (e.g. openai/gpt-4o-mini)')
    .option('-s, --system <text>', 'system prompt to prepend')
    .option('-t, --temperature <n>', 'sampling temperature (0-2)', (v) => Number.parseFloat(v))
    .action(async (promptParts: string[], opts: { model?: string; system?: string; temperature?: number }) => {
      const prompt = promptParts.join(' ');
      const ac = new AbortController();
      const onSigint = (): void => ac.abort();
      process.once('SIGINT', onSigint);
      try {
        const askOptions: { model?: string; system?: string; temperature?: number } = {};
        if (opts.model !== undefined) askOptions.model = opts.model;
        if (opts.system !== undefined) askOptions.system = opts.system;
        if (opts.temperature !== undefined && Number.isFinite(opts.temperature)) {
          askOptions.temperature = opts.temperature;
        }
        const { exitCode } = await runAsk(prompt, askOptions, { signal: ac.signal });
        if (exitCode !== 0) process.exitCode = exitCode;
      } finally {
        process.removeListener('SIGINT', onSigint);
      }
    });

  program
    .command('chat', { isDefault: true })
    .description('start the interactive Atlas TUI (default when no command given)')
    .option('-m, --model <id>', 'override the default model')
    .option('-a, --agent <name>', 'start in this agent (otherwise the first installed)')
    .option('--no-tui', 'use the plain readline REPL instead of the full-screen TUI')
    .option(
      '--ui <runtime>',
      'TUI runtime: "opentui" (default) or "ink" (classic fallback)',
      'opentui'
    )
    .option('--resume [id]', "resume a saved session (omit id for the latest)")
    .action(
      async (opts: {
        model?: string;
        agent?: string;
        tui?: boolean;
        ui?: string;
        resume?: string | boolean;
      }) => {
        if (opts.tui === false) {
          const replDeps: { model?: string } = {};
          if (opts.model !== undefined) replDeps.model = opts.model;
          const { exitCode } = await runRepl(replDeps);
          if (exitCode !== 0) process.exitCode = exitCode;
          return;
        }
        const tuiOpts: {
          model?: string;
          agent?: string;
          resume?: string;
          ui?: 'ink' | 'opentui';
        } = {};
        if (opts.model !== undefined) tuiOpts.model = opts.model;
        if (opts.agent !== undefined) tuiOpts.agent = opts.agent;
        if (opts.resume !== undefined) {
          tuiOpts.resume = typeof opts.resume === 'string' ? opts.resume : 'latest';
        }
        if (opts.ui === 'opentui' || opts.ui === 'ink') tuiOpts.ui = opts.ui;
        const { exitCode } = await runTui(tuiOpts);
        if (exitCode !== 0) process.exitCode = exitCode;
      }
    );

  program
    .command('init')
    .description('install built-in agents and starter skills into ~/.atlas/')
    .option('-f, --force', 'overwrite existing files')
    .action(async (opts: { force?: boolean }) => {
      const { exitCode } = await runInit({ force: opts.force === true });
      if (exitCode !== 0) process.exitCode = exitCode;
    });

  program
    .command('status')
    .description('print detected project state and recommended agent')
    .option('--json', 'print machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const { exitCode } = await runStatus({ json: opts.json === true });
      if (exitCode !== 0) process.exitCode = exitCode;
    });

  program
    .command('searxng')
    .description('manage the local SearXNG container backing web_search')
    .argument('[subcommand]', 'status | install | start | stop | remove', 'status')
    .action(async (sub: string) => {
      const { exitCode } = await runSearxng({ sub });
      if (exitCode !== 0) process.exitCode = exitCode;
    });

  program
    .command('vscode-setup')
    .description("patch VS Code's settings.json so the terminal forwards Ctrl+P / Ctrl+Shift+P / etc. to Atlas")
    .option('--dry-run', 'print the patched JSON instead of writing')
    .option('--path <file>', 'override settings.json location')
    .action(async (opts: { dryRun?: boolean; path?: string }) => {
      const setupOpts: { dryRun?: boolean; path?: string } = {};
      if (opts.dryRun) setupOpts.dryRun = true;
      if (opts.path) setupOpts.path = opts.path;
      const { exitCode } = await runVscodeSetup(setupOpts);
      if (exitCode !== 0) process.exitCode = exitCode;
    });

  return program;
};

export const run = async (argv: readonly string[]): Promise<void> => {
  const program = buildProgram();
  log.debug({ argv }, 'parsing argv');
  await program.parseAsync(argv as string[]);
};
