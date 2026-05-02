import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executePlan } from './executor.js';
import { writePlan, type Plan } from './plan.js';
import { startTask } from './state.js';
import type { TaskState } from './types.js';

const sh = (cmd: string, args: readonly string[], cwd: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd, stdio: 'ignore', env: process.env });
    c.on('error', reject);
    c.on('close', (code) => resolve(code ?? 0));
  });

const initRepo = async (cwd: string): Promise<void> => {
  if ((await sh('git', ['init', '-b', 'main'], cwd)) !== 0) throw new Error('git init failed');
  await sh('git', ['config', 'user.email', 'test@atlas'], cwd);
  await sh('git', ['config', 'user.name', 'Atlas Test'], cwd);
  await writeFile(join(cwd, 'README.md'), '# initial\n', 'utf8');
  await sh('git', ['add', '-A'], cwd);
  await sh('git', ['commit', '-m', 'init'], cwd);
};

const samplePlan = (): Plan => ({
  version: 1,
  tasks: [
    {
      id: '01',
      name: 'add foo',
      files: ['foo.txt'],
      action: 'create foo',
      verify: 'test -f foo.txt',
      done: 'foo.txt exists',
      deps: []
    },
    {
      id: '02',
      name: 'add bar',
      files: ['bar.txt'],
      action: 'create bar',
      verify: 'test -f bar.txt',
      done: 'bar.txt exists',
      deps: []
    }
  ]
});

describe('workflow/executor: executePlan (integration with real git)', () => {
  let cwd: string;
  let state: TaskState;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'atlas-exec-'));
    await initRepo(cwd);
    const r = await startTask({ cwd, title: 'demo' });
    if (!r.ok) throw new Error('startTask');
    state = r.value;
    const w = await writePlan(state, samplePlan());
    if (!w.ok) throw new Error('writePlan failed: ' + w.error.message);
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('runs both tasks in parallel, verifies, commits, marks state done', async () => {
    const seen: string[] = [];
    const report = await executePlan({
      state,
      run: async ({ task, worktree }) => {
        seen.push(task.id);
        // Create the file the verify command expects.
        await writeFile(join(worktree.path, `${task.name.split(' ')[1]}.txt`), 'hi\n', 'utf8');
        return { ok: true, summary: `child wrote ${task.name}` };
      }
    });
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.allOk).toBe(true);
      expect(report.value.outcomes.length).toBe(2);
      for (const o of report.value.outcomes) {
        expect(o.ok).toBe(true);
        expect(o.stage).toBe('done');
        expect(o.commitSha).toBeDefined();
      }
      expect(seen.sort()).toEqual(['01', '02']);
    }
    // State updated
    const { loadActiveTask } = await import('./state.js');
    const reload = await loadActiveTask(cwd);
    if (reload.ok && reload.value) {
      expect(reload.value.allTasksCommitted).toBe(true);
      expect(reload.value.allVerifyPassed).toBe(true);
      expect(reload.value.worktreeIds).toContain('01');
      expect(reload.value.worktreeIds).toContain('02');
    }
  });

  it('halts the wave on agent failure and reports stage=agent', async () => {
    const report = await executePlan({
      state,
      run: async () => ({ ok: false, summary: 'child blew up', error: 'simulated' })
    });
    if (report.ok) {
      expect(report.value.allOk).toBe(false);
      expect(report.value.outcomes.every((o) => o.stage === 'agent' && !o.ok)).toBe(true);
    }
  });

  it('halts when verify fails and reports stage=verify', async () => {
    const report = await executePlan({
      state,
      run: async () => ({ ok: true, summary: 'agent did nothing' }) // file never created → test -f fails
    });
    if (report.ok) {
      expect(report.value.allOk).toBe(false);
      const failed = report.value.outcomes.filter((o) => !o.ok);
      expect(failed.length).toBeGreaterThan(0);
      expect(failed[0]!.stage).toBe('verify');
    }
  });

  it('retries on verify failure, succeeds on second attempt', async () => {
    const perTask = new Map<string, number>();
    const report = await executePlan({
      state,
      maxVerifyRetries: 2,
      run: async ({ task, worktree }) => {
        const n = (perTask.get(task.id) ?? 0) + 1;
        perTask.set(task.id, n);
        // First attempt: do nothing (verify fails). Second+: create file.
        if (n >= 2) {
          await writeFile(join(worktree.path, `${task.name.split(' ')[1]}.txt`), 'fixed\n', 'utf8');
        }
        return { ok: true, summary: `attempt ${n}` };
      }
    });
    if (report.ok) {
      expect(report.value.allOk).toBe(true);
      for (const o of report.value.outcomes) {
        expect(o.ok).toBe(true);
        expect(o.attempts).toBe(2);
      }
    }
  });

  it('exhausts retries and reports verify FAIL with attempt count', async () => {
    const report = await executePlan({
      state,
      maxVerifyRetries: 2,
      run: async () => ({ ok: true, summary: 'never fixes anything' })
    });
    if (report.ok) {
      expect(report.value.allOk).toBe(false);
      const failed = report.value.outcomes.filter((o) => !o.ok);
      expect(failed.length).toBeGreaterThan(0);
      expect(failed[0]!.stage).toBe('verify');
      expect(failed[0]!.attempts).toBe(3); // initial + 2 retries
      expect(failed[0]!.error).toMatch(/3 attempts/);
    }
  });
});
