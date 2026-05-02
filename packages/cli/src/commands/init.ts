/**
 * `atlas init` — copies built-in agents and starter skills to ~/.atlas/.
 * Idempotent: existing files are left alone unless `--force` is passed.
 *
 * On the first run we also offer to install + start a local SearXNG
 * Docker container, since `web_search` won't work without one. The
 * prompt is skipped when stdin is non-TTY (CI/scripted runs) or when
 * SearXNG is already running.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ALL_BUILTINS, searxngStart, searxngStatus } from '@atlas/core';

export interface InitResult {
  readonly exitCode: number;
  readonly written: readonly string[];
  readonly skipped: readonly string[];
}

export interface InitOptions {
  readonly force?: boolean;
  readonly dir?: string;
  readonly stdout?: NodeJS.WritableStream;
  /** Set false to skip the SearXNG prompt (tests / scripted runs). */
  readonly offerSearxng?: boolean;
}

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

const promptYes = async (question: string): Promise<boolean> => {
  process.stdout.write(`${question} [Y/n]: `);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      const ans = chunk.toString('utf8').trim().toLowerCase();
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(ans === '' || ans === 'y' || ans === 'yes');
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
};

const offerSearxngInstall = async (stdout: NodeJS.WritableStream): Promise<void> => {
  // Only meaningful in interactive terminals — skip CI/scripted runs.
  if (!process.stdin.isTTY) return;
  const status = await searxngStatus();
  if (status.running) {
    stdout.write(`\nSearXNG is already running at ${status.url ?? '127.0.0.1'}.\n`);
    return;
  }
  if (!status.dockerInstalled) {
    stdout.write(
      '\nSearXNG (the local engine that powers `web_search`) needs Docker.\n' +
        'Install Docker first, then run `atlas searxng install`.\n'
    );
    return;
  }
  stdout.write(
    '\nAtlas can run a local SearXNG container so `web_search` works with no API keys.\n' +
      'It uses ~150MB RAM and binds to 127.0.0.1 only (no public exposure).\n'
  );
  const yes = await promptYes('Install + start SearXNG now?');
  if (!yes) {
    stdout.write('Skipped. Run `atlas searxng install` later when you want web_search.\n');
    return;
  }
  stdout.write('searxng: starting (image pull may take a minute)…\n');
  const r = await searxngStart({
    progress: (line) => stdout.write(line)
  });
  if (!r.ok) {
    stdout.write(`searxng: failed: ${r.error.message}\n`);
    return;
  }
  stdout.write(`searxng: running at ${r.value.url ?? '(unknown)'}\n`);
};

export const runInit = async (opts: InitOptions = {}): Promise<InitResult> => {
  const root = opts.dir ?? join(homedir(), '.atlas');
  const stdout = opts.stdout ?? process.stdout;
  const written: string[] = [];
  const skipped: string[] = [];

  for (const f of ALL_BUILTINS) {
    const target = join(root, f.relPath);
    if (!opts.force && (await fileExists(target))) {
      skipped.push(target);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.content, 'utf8');
    written.push(target);
  }

  stdout.write(
    `atlas init: wrote ${written.length} file(s), skipped ${skipped.length} (use --force to overwrite)\n`
  );
  for (const p of written) stdout.write(`  + ${p}\n`);

  if (opts.offerSearxng !== false) {
    await offerSearxngInstall(stdout);
  }

  return { exitCode: 0, written, skipped };
};

