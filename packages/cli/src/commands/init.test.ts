import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { runInit } from './init.js';

const collect = (): { stream: Writable; text: () => string } => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    }
  });
  return { stream, text: () => chunks.join('') };
};

describe('runInit', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-init-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes built-in files on first run', async () => {
    const out = collect();
    const r = await runInit({ dir, stdout: out.stream });
    expect(r.exitCode).toBe(0);
    expect(r.written.length).toBeGreaterThan(0);
    const athena = await readFile(join(dir, 'agents/athena/AGENT.md'), 'utf8');
    expect(athena).toContain('Athena');
  });

  it('skips existing files without --force', async () => {
    await runInit({ dir });
    const out = collect();
    const r = await runInit({ dir, stdout: out.stream });
    expect(r.written).toHaveLength(0);
    expect(r.skipped.length).toBeGreaterThan(0);
  });

  it('overwrites with --force', async () => {
    await runInit({ dir });
    const r = await runInit({ dir, force: true });
    expect(r.written.length).toBeGreaterThan(0);
  });
});
