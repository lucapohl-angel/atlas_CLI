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

  it('ship_summary lists branches with diff stats and a token estimate per mode', async () => {
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
      expect(r.value.summary).toMatch(/~\d.* tokens/); // review-mode estimate
      expect(r.value.summary).toMatch(/insertion/); // shortstat
      expect(r.value.data?.estReviewTokens).toBeTypeOf('number');
    }
  });

  it('ship_apply mode=manual prints git, gh, and (if origin set) GitHub web URLs', async () => {
    // add a fake github origin so the web URL path runs
    await sh('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd });
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
      expect(r.value.summary).toContain(
        'https://github.com/acme/widgets/compare/main...atlas/01-first?expand=1'
      );
    }
  });

  it('ship_apply mode=manual without a github origin omits web URLs and notes that', async () => {
    const { shipApplyTool } = await import('./workflow.js');
    const r = await shipApplyTool.execute({ mode: 'manual' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).not.toContain('https://github.com');
      expect(r.value.summary).toMatch(/no github\.com origin detected/);
    }
  });

  it('ship_apply mode=review returns per-branch diffs with token totals', async () => {
    const { shipApplyTool } = await import('./workflow.js');
    const r = await shipApplyTool.execute({ mode: 'review' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toContain('=== atlas/01-first');
      expect(r.value.summary).toContain('=== atlas/02-second');
      expect(r.value.summary).toContain('a.txt');
      expect(r.value.summary).toContain('b.txt');
      expect(r.value.summary).toMatch(/Total review payload: ~\d+ tokens/);
      expect(r.value.data?.estTokens).toBeGreaterThan(0);
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

  it('ship_apply mode=auto preserves earlier merges and prints recipe on conflict', async () => {
    // Make atlas/02-second touch a file that base also touches → guaranteed conflict.
    const { writeFile } = await import('node:fs/promises');
    // First put a conflicting line on main
    await writeFile(join(cwd, 'shared.txt'), 'main version\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'main: shared'], { cwd });
    // And a different line on atlas/02-second
    await sh('git', ['checkout', 'atlas/02-second'], { cwd });
    await writeFile(join(cwd, 'shared.txt'), 'branch version\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'second: shared'], { cwd });
    await sh('git', ['checkout', 'main'], { cwd });

    const baseShaBefore = (await sh('git', ['rev-parse', 'main'], { cwd })).stdout.trim();
    const { shipApplyTool } = await import('./workflow.js');
    const r = await shipApplyTool.execute({ mode: 'auto' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // atlas/01-first should have merged cleanly (it touches a.txt only).
      expect(r.value.summary).toMatch(/merged atlas\/01-first/);
      expect(r.value.summary).toMatch(/atlas\/02-second.*merge conflict/);
      expect(r.value.summary).toMatch(/State: 1\/2 branches landed/);
      expect(r.value.summary).toMatch(/git merge --no-ff atlas\/02-second/);
      expect(r.value.summary).toMatch(/conflicting files/);
    }
    // Working tree must be clean after abort (no merge in progress).
    const status = (
      await sh('git', ['status', '--porcelain', '--untracked-files=no'], { cwd })
    ).stdout.trim();
    expect(status).toBe('');
    // base should now be ahead of where it was (atlas/01-first landed).
    const baseShaAfter = (await sh('git', ['rev-parse', 'main'], { cwd })).stdout.trim();
    expect(baseShaAfter).not.toBe(baseShaBefore);
  });

  it('ship_apply mode=auto autoResolve=ours keeps the base side on conflict', async () => {
    // Make atlas/02-second touch shared.txt with conflicting content.
    const { writeFile, readFile } = await import('node:fs/promises');
    await writeFile(join(cwd, 'shared.txt'), 'main version\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'main: shared'], { cwd });
    await sh('git', ['checkout', 'atlas/02-second'], { cwd });
    await writeFile(join(cwd, 'shared.txt'), 'branch version\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'second: shared'], { cwd });
    await sh('git', ['checkout', 'main'], { cwd });

    const { shipApplyTool } = await import('./workflow.js');
    const r = await shipApplyTool.execute({ mode: 'auto', autoResolve: 'ours' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toMatch(/merged atlas\/01-first/);
      expect(r.value.summary).toMatch(/merged atlas\/02-second.*-X ours/);
      expect(r.value.summary).toMatch(/Auto-resolved/);
    }
    // shared.txt should still be the main version (ours).
    const content = await readFile(join(cwd, 'shared.txt'), 'utf8');
    expect(content).toBe('main version\n');
  });

  it('ship_apply mode=auto falls back to ctx.shipDefaults.autoResolve when input omits it', async () => {
    // Conflict scenario.
    const { writeFile, readFile } = await import('node:fs/promises');
    await writeFile(join(cwd, 'shared.txt'), 'main version\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'main: shared'], { cwd });
    await sh('git', ['checkout', 'atlas/02-second'], { cwd });
    await writeFile(join(cwd, 'shared.txt'), 'branch version\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'second: shared'], { cwd });
    await sh('git', ['checkout', 'main'], { cwd });

    // Host configures shipDefaults.autoResolve='theirs'; the model omits
    // input.autoResolve. Tool should pick up the host default.
    const ctxWithDefault: ToolContext = {
      ...ctx,
      shipDefaults: { autoResolve: 'theirs' }
    };
    const { shipApplyTool } = await import('./workflow.js');
    const r = await shipApplyTool.execute({ mode: 'auto' }, ctxWithDefault);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toMatch(/autoResolve: theirs/);
      expect(r.value.summary).toMatch(/-X theirs/);
    }
    const content = await readFile(join(cwd, 'shared.txt'), 'utf8');
    expect(content).toBe('branch version\n');
  });

  it('ship_apply mode=auto calls shipResolveAsk on conflict and applies the user pick', async () => {
    const { writeFile, readFile } = await import('node:fs/promises');
    await writeFile(join(cwd, 'shared.txt'), 'main version\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'main: shared'], { cwd });
    await sh('git', ['checkout', 'atlas/02-second'], { cwd });
    await writeFile(join(cwd, 'shared.txt'), 'branch version\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'second: shared'], { cwd });
    await sh('git', ['checkout', 'main'], { cwd });

    const asked: { branch: string; files: readonly string[] }[] = [];
    const ctxAsk: ToolContext = {
      ...ctx,
      shipResolveAsk: async (req) => {
        asked.push({ branch: req.branch, files: req.conflictFiles });
        return { strategy: 'ours', persist: false };
      }
    };
    const { shipApplyTool } = await import('./workflow.js');
    const r = await shipApplyTool.execute({ mode: 'auto' }, ctxAsk);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toMatch(/user chose ours/);
      expect(r.value.summary).toMatch(/-X ours/);
    }
    expect(asked).toHaveLength(1);
    expect(asked[0]?.branch).toBe('atlas/02-second');
    expect(asked[0]?.files).toContain('shared.txt');
    const content = await readFile(join(cwd, 'shared.txt'), 'utf8');
    expect(content).toBe('main version\n');
  });

  it('ship_apply mode=auto skips shipResolveAsk when promptOnConflict=false', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(cwd, 'shared.txt'), 'main version\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'main: shared'], { cwd });
    await sh('git', ['checkout', 'atlas/02-second'], { cwd });
    await writeFile(join(cwd, 'shared.txt'), 'branch version\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'second: shared'], { cwd });
    await sh('git', ['checkout', 'main'], { cwd });

    let askedCount = 0;
    const ctxNoPrompt: ToolContext = {
      ...ctx,
      shipDefaults: { autoResolve: 'abort', promptOnConflict: false },
      shipResolveAsk: async () => {
        askedCount += 1;
        return { strategy: 'ours', persist: false };
      }
    };
    const { shipApplyTool } = await import('./workflow.js');
    const r = await shipApplyTool.execute({ mode: 'auto' }, ctxNoPrompt);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toMatch(/aborted/);
    }
    expect(askedCount).toBe(0);
  });

  it('ship_apply mode=auto autoResolve=theirs keeps the branch side on conflict', async () => {
    const { writeFile, readFile } = await import('node:fs/promises');
    await writeFile(join(cwd, 'shared.txt'), 'main version\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'main: shared'], { cwd });
    await sh('git', ['checkout', 'atlas/02-second'], { cwd });
    await writeFile(join(cwd, 'shared.txt'), 'branch version\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'second: shared'], { cwd });
    await sh('git', ['checkout', 'main'], { cwd });

    const { shipApplyTool } = await import('./workflow.js');
    const r = await shipApplyTool.execute({ mode: 'auto', autoResolve: 'theirs' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toMatch(/merged atlas\/02-second.*-X theirs/);
    }
    const content = await readFile(join(cwd, 'shared.txt'), 'utf8');
    expect(content).toBe('branch version\n');
  });

  it('ship_apply mode=auto autoResolve=ai uses delegateRun to fix conflicts then commits', async () => {
    const { writeFile, readFile } = await import('node:fs/promises');
    await writeFile(join(cwd, 'shared.txt'), 'main\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'main: shared'], { cwd });
    await sh('git', ['checkout', 'atlas/02-second'], { cwd });
    await writeFile(join(cwd, 'shared.txt'), 'branch\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'second: shared'], { cwd });
    await sh('git', ['checkout', 'main'], { cwd });

    // Fake delegateRun: pretend the agent picked a hybrid resolution.
    const ctxAi: ToolContext = {
      ...ctx,
      delegateRun: async () => {
        await writeFile(join(cwd, 'shared.txt'), 'main + branch (ai resolved)\n', 'utf8');
        await sh('git', ['add', 'shared.txt'], { cwd });
        return { ok: true, summary: 'resolved 1 file', rounds: 1 };
      }
    };
    const { shipApplyTool } = await import('./workflow.js');
    const r = await shipApplyTool.execute({ mode: 'auto', autoResolve: 'ai' }, ctxAi);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toMatch(/merged atlas\/02-second.*ai-resolved/);
      expect(r.value.summary).toMatch(/agent: resolved 1 file/);
    }
    const content = await readFile(join(cwd, 'shared.txt'), 'utf8');
    expect(content).toBe('main + branch (ai resolved)\n');
    // Commit should exist with the ai-resolved marker.
    const log = (await sh('git', ['log', '-1', '--pretty=%s'], { cwd })).stdout.trim();
    expect(log).toMatch(/ai-resolved/);
  });

  it('ship_apply mode=auto autoResolve=ai aborts cleanly when the agent leaves markers behind', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(cwd, 'shared.txt'), 'main\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'main: shared'], { cwd });
    await sh('git', ['checkout', 'atlas/02-second'], { cwd });
    await writeFile(join(cwd, 'shared.txt'), 'branch\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'second: shared'], { cwd });
    await sh('git', ['checkout', 'main'], { cwd });

    // Fake delegateRun that does nothing — leaves conflict markers in place.
    const ctxBad: ToolContext = {
      ...ctx,
      delegateRun: async () => ({ ok: true, summary: 'gave up', rounds: 0 })
    };
    const { shipApplyTool } = await import('./workflow.js');
    const r = await shipApplyTool.execute({ mode: 'auto', autoResolve: 'ai' }, ctxBad);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toMatch(/ai resolution failed/);
      expect(r.value.summary).toMatch(/aborted/);
    }
    // Working tree must be clean after the failed AI resolve + abort.
    const status = (
      await sh('git', ['status', '--porcelain', '--untracked-files=no'], { cwd })
    ).stdout.trim();
    expect(status).toBe('');
  });

  it('ship_apply mode=auto autoResolve=ai falls back to abort when delegateRun is not wired', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(cwd, 'shared.txt'), 'main\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'main: shared'], { cwd });
    await sh('git', ['checkout', 'atlas/02-second'], { cwd });
    await writeFile(join(cwd, 'shared.txt'), 'branch\n', 'utf8');
    await sh('git', ['add', 'shared.txt'], { cwd });
    await sh('git', ['commit', '-m', 'second: shared'], { cwd });
    await sh('git', ['checkout', 'main'], { cwd });

    const { shipApplyTool } = await import('./workflow.js');
    const r = await shipApplyTool.execute({ mode: 'auto', autoResolve: 'ai' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toMatch(/host did not wire ctx\.delegateRun/);
      expect(r.value.summary).toMatch(/aborted/);
    }
  });
});
