import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendContextEntry, finalizeContext, readContext } from './context.js';
import { startTask } from './state.js';
import type { TaskState } from './types.js';

describe('workflow/context', () => {
  let cwd: string;
  let state: TaskState;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'atlas-ctx-'));
    const r = await startTask({ cwd, title: 'demo' });
    if (!r.ok) throw new Error('startTask failed');
    state = r.value;
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('readContext returns null when nothing written', async () => {
    const r = await readContext(state);
    expect(r.ok && r.value).toBeNull();
  });

  it('appendContextEntry creates draft with header on first call', async () => {
    const r = await appendContextEntry(state, {
      heading: 'Q: pick database',
      body: 'Postgres for prod, SQLite for tests.',
      category: 'storage'
    });
    expect(r.ok).toBe(true);
    const read = await readContext(state);
    expect(read.ok).toBe(true);
    if (read.ok && read.value) {
      expect(read.value).toContain('# Context: demo');
      expect(read.value).toContain('## Q: pick database');
      expect(read.value).toContain('storage');
      expect(read.value).toContain('Postgres for prod');
    }
  });

  it('appendContextEntry appends multiple entries cleanly', async () => {
    await appendContextEntry(state, { heading: 'Q1', body: 'A1' });
    await appendContextEntry(state, { heading: 'Q2', body: 'A2' });
    const read = await readContext(state);
    if (read.ok && read.value) {
      expect(read.value.indexOf('## Q1')).toBeLessThan(read.value.indexOf('## Q2'));
    }
  });

  it('finalizeContext requires a draft to exist', async () => {
    const r = await finalizeContext(state);
    expect(r.ok).toBe(false);
  });

  it('finalizeContext promotes draft to CONTEXT.md and embeds summary', async () => {
    await appendContextEntry(state, { heading: 'Q', body: 'A' });
    const fin = await finalizeContext(state, 'Build a Postgres-backed API.');
    expect(fin.ok).toBe(true);
    if (fin.ok) {
      const body = await readFile(fin.value.path, 'utf8');
      expect(body).toContain('## Summary');
      expect(body).toContain('Build a Postgres-backed API.');
      expect(body).toContain('<!-- atlas:finalized -->');
      expect(fin.value.path.endsWith('CONTEXT.md')).toBe(true);
    }
  });
});
