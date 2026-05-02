import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSignals } from './signals.js';
import { startTask, taskDir } from './state.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'atlas-workflow-signals-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('readSignals', () => {
  it('reports false for both docs when nothing exists', async () => {
    const t = await startTask({ cwd, title: 't' });
    if (!t.ok) throw t.error;
    const s = await readSignals(t.value);
    expect(s.hasContextDoc).toBe(false);
    expect(s.hasPlanDoc).toBe(false);
    expect(s.allTasksCommitted).toBe(false);
    expect(s.allVerifyPassed).toBe(false);
  });

  it('detects CONTEXT.md and PLAN.xml when present', async () => {
    const t = await startTask({ cwd, title: 't' });
    if (!t.ok) throw t.error;
    const dir = taskDir(cwd, t.value.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'CONTEXT.md'), '# context\n', 'utf8');
    await writeFile(join(dir, 'PLAN.xml'), '<plan/>\n', 'utf8');
    const s = await readSignals(t.value);
    expect(s.hasContextDoc).toBe(true);
    expect(s.hasPlanDoc).toBe(true);
  });
});
