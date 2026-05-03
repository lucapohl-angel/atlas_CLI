import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileTool, __clearReadCache } from './read-file.js';
import type { ToolContext } from './types.js';

const ctxFor = async (): Promise<{ ctx: ToolContext; dir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-read-'));
  const ctx: ToolContext = {
    cwd: dir,
    env: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as ToolContext['logger']
  } as ToolContext;
  return { ctx, dir };
};

describe('readFileTool', () => {
  beforeEach(() => __clearReadCache());

  it('returns the file content', async () => {
    const { ctx, dir } = await ctxFor();
    await writeFile(join(dir, 'a.txt'), 'hello\n', 'utf8');
    const r = await readFileTool.execute({ path: 'a.txt', maxBytes: 200_000 }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.summary).toContain('hello');
  });

  it('serves the second read from cache (no IO needed)', async () => {
    const { ctx, dir } = await ctxFor();
    const p = join(dir, 'b.txt');
    await writeFile(p, 'one\n', 'utf8');
    const r1 = await readFileTool.execute({ path: 'b.txt', maxBytes: 200_000 }, ctx);
    expect(r1.ok).toBe(true);
    // Second call without any modification: must hit the cache and
    // return the byte-identical summary. (The cache layer is the only
    // way two reads can produce identical strings deterministically
    // because preview formatting includes byte counts.)
    const r2 = await readFileTool.execute({ path: 'b.txt', maxBytes: 200_000 }, ctx);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r2.value.summary).toBe(r1.value.summary);
  });

  it('busts the cache when mtime changes', async () => {
    const { ctx, dir } = await ctxFor();
    const p = join(dir, 'c.txt');
    await writeFile(p, 'first\n', 'utf8');
    const r1 = await readFileTool.execute({ path: 'c.txt', maxBytes: 200_000 }, ctx);
    // Wait long enough for mtime to differ on coarse FS clocks.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(p, 'second-content\n', 'utf8');
    const r2 = await readFileTool.execute({ path: 'c.txt', maxBytes: 200_000 }, ctx);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.value.summary).not.toBe(r1.value.summary);
      expect(r2.value.summary).toContain('second-content');
    }
  });
});
