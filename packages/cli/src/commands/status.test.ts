import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runStatus } from './status.js';

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

describe('runStatus', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-status-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prints athena recommendation for empty project', async () => {
    const out = collect();
    await runStatus({ cwd: dir, stdout: out.stream });
    expect(out.text()).toContain('athena');
  });

  it('prints hercules when stories exist', async () => {
    await mkdir(join(dir, 'docs', 'stories'), { recursive: true });
    await mkdir(join(dir, 'context'));
    await writeFile(join(dir, 'docs', 'prd.md'), '#');
    await writeFile(join(dir, 'docs', 'architecture.md'), '#');
    await writeFile(join(dir, 'context', 'project-overview.md'), '#');
    await writeFile(join(dir, 'docs', 'stories', 's1.md'), '#');
    const out = collect();
    await runStatus({ cwd: dir, stdout: out.stream });
    expect(out.text()).toContain('hercules');
  });
});
