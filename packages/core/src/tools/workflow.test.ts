import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTask } from '../workflow/state.js';
import {
  contextFinalizeTool,
  contextNoteTool,
  contextShowTool,
  planCheckTool,
  planExecuteTool,
  planShowTool,
  planWriteTool
} from './workflow.js';
import type { ToolContext } from './types.js';

const allowAll: ToolContext['approve'] = { decide: () => ({ action: 'allow' as const }) };

describe('tools/workflow: requireActiveTask', () => {
  it('all tools fail cleanly when no active task exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'atlas-tools-noact-'));
    const ctx: ToolContext = { cwd, approve: allowAll };
    try {
      const r1 = await contextNoteTool.execute({ heading: 'q', body: 'a' }, ctx);
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.error.code).toBe('WORKFLOW_TASK_NOT_FOUND');
      const r2 = await contextShowTool.execute({}, ctx);
      expect(r2.ok).toBe(false);
      const r3 = await contextFinalizeTool.execute({}, ctx);
      expect(r3.ok).toBe(false);
      const r4 = await planWriteTool.execute(
        { tasks: [{ id: '01', name: 'x', files: ['a.ts'], action: 'a', verify: 'v', done: 'd' }] },
        ctx
      );
      expect(r4.ok).toBe(false);
      const r5 = await planShowTool.execute({}, ctx);
      expect(r5.ok).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('tools/workflow: context_* end-to-end', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'atlas-tools-ctx-'));
    const r = await startTask({ cwd, title: 'demo' });
    if (!r.ok) throw new Error('startTask');
    ctx = { cwd, approve: allowAll };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('note → show → finalize → show', async () => {
    const note = await contextNoteTool.execute(
      { heading: 'Q: db?', body: 'Postgres', category: 'storage' },
      ctx
    );
    expect(note.ok).toBe(true);
    if (note.ok) expect(note.value.summary).toContain('Q: db?');

    const show1 = await contextShowTool.execute({}, ctx);
    expect(show1.ok).toBe(true);
    if (show1.ok) {
      expect(show1.value.summary).toContain('Postgres');
      expect(show1.value.summary).toContain('# Context: demo');
    }

    const fin = await contextFinalizeTool.execute({ summary: 'use postgres' }, ctx);
    expect(fin.ok).toBe(true);
    if (fin.ok) expect(fin.value.summary).toMatch(/finalized at/);

    const show2 = await contextShowTool.execute({}, ctx);
    if (show2.ok) {
      expect(show2.value.summary).toContain('## Summary');
      expect(show2.value.summary).toContain('use postgres');
    }
  });

  it('finalize before any note fails', async () => {
    const fin = await contextFinalizeTool.execute({}, ctx);
    expect(fin.ok).toBe(false);
  });

  it('show with no context returns the empty marker', async () => {
    const show = await contextShowTool.execute({}, ctx);
    if (show.ok) expect(show.value.summary).toBe('(no context yet)');
  });
});

describe('tools/workflow: plan_* end-to-end', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'atlas-tools-plan-'));
    const r = await startTask({ cwd, title: 'demo' });
    if (!r.ok) throw new Error('startTask');
    ctx = { cwd, approve: allowAll };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('write → show → check', async () => {
    const w = await planWriteTool.execute(
      {
        tasks: [
          {
            id: '01',
            name: 'add hash',
            files: ['src/auth/hash.ts'],
            action: 'implement bcrypt hash',
            verify: 'pnpm test src/auth/hash.test.ts',
            done: 'tests pass'
          },
          {
            id: '02',
            name: 'wire login',
            files: ['src/auth/login.ts'],
            action: 'use hash() in login',
            verify: 'pnpm test src/auth/login.test.ts',
            done: 'login uses hash',
            deps: ['01']
          }
        ]
      },
      ctx
    );
    expect(w.ok).toBe(true);
    if (w.ok) {
      expect(w.value.summary).toMatch(/2 tasks at .*PLAN\.xml/);
      const xml = await readFile(
        (w.value.data as { path: string }).path,
        'utf8'
      );
      expect(xml).toContain('<plan version="1">');
      expect(xml).toContain('add hash');
    }

    const show = await planShowTool.execute({}, ctx);
    if (show.ok) {
      expect(show.value.summary).toContain('01 add hash');
      expect(show.value.summary).toContain('02 wire login');
      expect(show.value.summary).toContain('deps: 01');
    }

    const check = await planCheckTool.execute({}, ctx);
    if (check.ok) expect(check.value.summary).toBe('ok: 2 tasks');
  });

  it('plan_write rejects bad plans without writing', async () => {
    const w = await planWriteTool.execute(
      {
        tasks: [
          {
            id: '01',
            name: 'x',
            files: ['a.ts'],
            action: 'a',
            verify: 'v',
            done: 'd',
            deps: ['ZZ']
          }
        ]
      },
      ctx
    );
    expect(w.ok).toBe(false);
    const show = await planShowTool.execute({}, ctx);
    if (show.ok) expect(show.value.summary).toBe('(no plan yet)');
  });

  it('plan_check accepts an inline xml string', async () => {
    const xml =
      '<plan version="1"><task id="01" name="x"><files><file>a.ts</file></files><action>a</action><verify>v</verify><done>d</done><deps/></task></plan>';
    const r = await planCheckTool.execute({ xml }, ctx);
    if (r.ok) expect(r.value.summary).toBe('ok: 1 tasks');
  });

  it('plan_check reports issues for malformed inline xml', async () => {
    const r = await planCheckTool.execute({ xml: '<not-a-plan/>' }, ctx);
    if (r.ok) expect(r.value.summary).toMatch(/^issues: parse:/);
  });

  it('plan_execute returns a clear error when host did not wire executePlanRun', async () => {
    // write a valid plan first so the failure is the runner check, not no-plan
    await planWriteTool.execute(
      { tasks: [{ id: '01', name: 'x', files: ['a.ts'], action: 'a', verify: 'v', done: 'd' }] },
      ctx
    );
    const r = await planExecuteTool.execute({}, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/not initialized/);
  });
});

describe('tools/workflow: ship_summary + ship_apply', () => {
  let cwd: string;
  let ctx: ToolContext;
  let sh: (cmd: string, args: readonly string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string }>;

  beforeEach(async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    sh = promisify(execFile) as typeof sh;
    cwd = await mkdtemp(join(tmpdir(), 'atlas-tools-ship-'));
    // init a real git repo with two atlas/* branches simulating a finished execute phase.
    await sh('git', ['init', '-q', '-b', 'main'], { cwd });
    await sh('git', ['config', 'user.email', 'a@b.c'], { cwd });
    await sh('git', ['config', 'user.name', 'a'], { cwd });
    await sh('git', ['commit', '--allow-empty', '-m', 'root'], { cwd });
    await sh('git', ['checkout', '-b', 'atlas/01-first'], { cwd });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(cwd, 'a.txt'), 'a\n', 'utf8');
    await sh('git', ['add', '-A'], { cwd });
    await sh('git', ['commit', '-m', 'feat(01): first'], { cwd });
    await sh('git', ['checkout', 'main'], { cwd });
    await sh('git', ['checkout', '-b', 'atlas/02-second'], { cwd });
    await writeFile(join(cwd, 'b.txt'), 'b\n', 'utf8');
    await sh('git', ['add', '-A'], { cwd });
    await sh('git', ['commit', '-m', 'feat(02): second'], { cwd });
    await sh('git', ['checkout', 'main'], { cwd });
    const r = await startTask({ cwd, title: 'ship demo' });
    if (!r.ok) throw new Error('startTask');
    const { updateTask } = await import('../workflow/state.js');
    await updateTask(r.value, { worktreeIds: ['01', '02'] });
    ctx = { cwd, approve: allowAll };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('ship_summary lists the atlas branches and prompts for a mode', async () => {
    const { shipSummaryTool } = await import('./workflow.js');
    const r = await shipSummaryTool.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toMatch(/2 branches/);
      expect(r.value.summary).toContain('atlas/01-first');
      expect(r.value.summary).toContain('atlas/02-second');
      expect(r.value.summary).toMatch(/\[a\] auto/);
      expect(r.value.summary).toMatch(/\[r\] review/);
      expect(r.value.summary).toMatch(/\[m\] manual/);
    }
  });

  it('ship_apply mode=manual prints paste-ready commands without touching the repo', async () => {
    const { shipApplyTool } = await import('./workflow.js');
    const before = (await sh('git', ['rev-parse', 'main'], { cwd })).stdout.trim();
    const r = await shipApplyTool.execute({ mode: 'manual' }, ctx);
    const after = (await sh('git', ['rev-parse', 'main'], { cwd })).stdout.trim();
    expect(after).toBe(before);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toMatch(/manual/);
      expect(r.value.summary).toContain('git merge --no-ff atlas/01-first');
      expect(r.value.summary).toContain('gh pr create');
    }
  });

  it('ship_apply mode=review returns per-branch diff stats and diffs', async () => {
    const { shipApplyTool } = await import('./workflow.js');
    const r = await shipApplyTool.execute({ mode: 'review' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toContain('=== atlas/01-first ===');
      expect(r.value.summary).toContain('=== atlas/02-second ===');
      expect(r.value.summary).toContain('a.txt');
      expect(r.value.summary).toContain('b.txt');
    }
  });

  it('ship_apply mode=auto merges all branches into base', async () => {
    const { shipApplyTool } = await import('./workflow.js');
    const r = await shipApplyTool.execute({ mode: 'auto' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toMatch(/merged atlas\/01-first/);
      expect(r.value.summary).toMatch(/merged atlas\/02-second/);
    }
    // both files should now be on main
    const { access } = await import('node:fs/promises');
    await access(join(cwd, 'a.txt'));
    await access(join(cwd, 'b.txt'));
  });

  it('ship_apply mode=auto refuses with uncommitted changes on base', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(cwd, 'dirty.txt'), 'dirty\n', 'utf8');
    await sh('git', ['add', 'dirty.txt'], { cwd }); // stage so status shows it
    const { shipApplyTool } = await import('./workflow.js');
    const r = await shipApplyTool.execute({ mode: 'auto' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/uncommitted/);
  });
});
