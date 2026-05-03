import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { editFileTool } from './edit-file.js';
import type { ToolContext } from './types.js';

const ctxFor = async (): Promise<{ ctx: ToolContext; dir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-edit-'));
  const ctx: ToolContext = {
    cwd: dir,
    env: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as ToolContext['logger']
  } as ToolContext;
  return { ctx, dir };
};

describe('editFileTool', () => {
  let ctx: ToolContext;
  let dir: string;

  beforeEach(async () => {
    ({ ctx, dir } = await ctxFor());
  });

  it('applies a single edit', async () => {
    const p = join(dir, 'a.txt');
    await writeFile(p, 'hello world\n', 'utf8');
    const r = await editFileTool.execute(
      { path: 'a.txt', edits: [{ oldString: 'world', newString: 'atlas' }], createIfMissing: false },
      ctx
    );
    expect(r.ok).toBe(true);
    expect(await readFile(p, 'utf8')).toBe('hello atlas\n');
  });

  it('applies multiple edits sequentially', async () => {
    const p = join(dir, 'b.txt');
    await writeFile(p, 'one\ntwo\nthree\n', 'utf8');
    const r = await editFileTool.execute(
      {
        path: 'b.txt',
        edits: [
          { oldString: 'one', newString: '1' },
          { oldString: 'three', newString: '3' }
        ],
        createIfMissing: false
      },
      ctx
    );
    expect(r.ok).toBe(true);
    expect(await readFile(p, 'utf8')).toBe('1\ntwo\n3\n');
  });

  it('refuses ambiguous match', async () => {
    const p = join(dir, 'c.txt');
    await writeFile(p, 'x\nx\n', 'utf8');
    const r = await editFileTool.execute(
      { path: 'c.txt', edits: [{ oldString: 'x', newString: 'y' }], createIfMissing: false },
      ctx
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/matches 2 places/);
  });

  it('refuses missing match', async () => {
    const p = join(dir, 'd.txt');
    await writeFile(p, 'foo\n', 'utf8');
    const r = await editFileTool.execute(
      { path: 'd.txt', edits: [{ oldString: 'bar', newString: 'baz' }], createIfMissing: false },
      ctx
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/not found/);
  });

  it('refuses paths escaping cwd', async () => {
    const r = await editFileTool.execute(
      { path: '../etc/passwd', edits: [{ oldString: 'a', newString: 'b' }], createIfMissing: false },
      ctx
    );
    expect(r.ok).toBe(false);
  });

  it('creates a new file when createIfMissing=true', async () => {
    await mkdir(join(dir, 'sub'), { recursive: true });
    const r = await editFileTool.execute(
      {
        path: 'sub/new.txt',
        edits: [{ oldString: '', newString: 'hello\n' }],
        createIfMissing: true
      },
      ctx
    );
    expect(r.ok).toBe(true);
    expect(await readFile(join(dir, 'sub/new.txt'), 'utf8')).toBe('hello\n');
  });
});
