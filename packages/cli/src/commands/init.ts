/**
 * `atlas init` — copies built-in agents and starter skills to ~/.atlas/.
 * Idempotent: existing files are left alone unless `--force` is passed.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ALL_BUILTINS } from '@atlas/core';

export interface InitResult {
  readonly exitCode: number;
  readonly written: readonly string[];
  readonly skipped: readonly string[];
}

export interface InitOptions {
  readonly force?: boolean;
  readonly dir?: string;
  readonly stdout?: NodeJS.WritableStream;
}

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
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
  return { exitCode: 0, written, skipped };
};
