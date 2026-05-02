import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPlan, parsePlan, readPlan, serializePlan, writePlan, type Plan } from './plan.js';
import { startTask } from './state.js';
import type { TaskState } from './types.js';

const samplePlan = (): Plan => ({
  version: 1,
  tasks: [
    {
      id: '01',
      name: 'add hash',
      files: ['src/auth/hash.ts'],
      action: 'implement bcrypt hash + verify',
      verify: 'pnpm test src/auth/hash.test.ts',
      done: 'hash + verify exported, tests pass',
      deps: []
    },
    {
      id: '02',
      name: 'wire login',
      files: ['src/auth/login.ts'],
      action: 'use hash() in login flow',
      verify: 'pnpm test src/auth/login.test.ts',
      done: 'login uses hash; tests cover success + failure',
      deps: ['01']
    }
  ]
});

describe('workflow/plan: serialize/parse round trip', () => {
  it('round-trips a plan through XML', () => {
    const plan = samplePlan();
    const xml = serializePlan(plan);
    expect(xml).toContain('<plan version="1">');
    expect(xml).toContain('<task id="01" name="add hash">');
    const parsed = parsePlan(xml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(plan);
    }
  });

  it('escapes XML special chars in names + actions', () => {
    const plan: Plan = {
      version: 1,
      tasks: [
        {
          id: 'a&b',
          name: 'add <Component> with "quotes"',
          files: ['x.ts'],
          action: 'a > b && c < d',
          verify: 'echo ok',
          done: "use 'apos' chars",
          deps: []
        }
      ]
    };
    const xml = serializePlan(plan);
    expect(xml).not.toContain("add <Component>"); // raw form must be escaped
    const parsed = parsePlan(xml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(plan);
  });

  it('round-trips an optional stopWhen field', () => {
    const plan: Plan = {
      version: 1,
      tasks: [
        {
          id: '01',
          name: 'flaky test',
          files: ['t.ts'],
          action: 'fix failing test',
          verify: 'pnpm test',
          done: 'green',
          stopWhen: 'abort after 3 retries; ask the user instead of refactoring shared code',
          deps: []
        }
      ]
    };
    const xml = serializePlan(plan);
    expect(xml).toContain('<stop_when>');
    const parsed = parsePlan(xml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(plan);
  });

  it('omits <stop_when> when not set', () => {
    const xml = serializePlan(samplePlan());
    expect(xml).not.toContain('<stop_when>');
  });
});

describe('workflow/plan: parsePlan errors', () => {
  it('rejects missing root', () => {
    const r = parsePlan('<not-a-plan/>');
    expect(r.ok).toBe(false);
  });
  it('rejects unsupported version', () => {
    const r = parsePlan('<plan version="9"><task id="01" name="x"><files><file>a.ts</file></files><action>a</action><verify>v</verify><done>d</done></task></plan>');
    expect(r.ok).toBe(false);
  });
  it('rejects task missing <action>', () => {
    const r = parsePlan(
      '<plan version="1"><task id="01" name="x"><files><file>a.ts</file></files><verify>v</verify><done>d</done></task></plan>'
    );
    expect(r.ok).toBe(false);
  });
  it('rejects task with empty <files>', () => {
    const r = parsePlan(
      '<plan version="1"><task id="01" name="x"><files></files><action>a</action><verify>v</verify><done>d</done></task></plan>'
    );
    expect(r.ok).toBe(false);
  });
  it('rejects plan with zero tasks', () => {
    const r = parsePlan('<plan version="1"></plan>');
    expect(r.ok).toBe(false);
  });
});

describe('workflow/plan: checkPlan', () => {
  it('returns no issues for a clean plan', () => {
    expect(checkPlan(samplePlan())).toEqual([]);
  });
  it('flags duplicate ids', () => {
    const plan = samplePlan();
    const dup: Plan = { version: 1, tasks: [...plan.tasks, { ...plan.tasks[0]! }] };
    const issues = checkPlan(dup);
    expect(issues.some((i) => i.message === 'duplicate task id')).toBe(true);
  });
  it('flags unknown deps', () => {
    const plan: Plan = {
      version: 1,
      tasks: [
        { id: '01', name: 'x', files: ['a.ts'], action: 'a', verify: 'v', done: 'd', deps: ['99'] }
      ]
    };
    const issues = checkPlan(plan);
    expect(issues.some((i) => i.message.includes('unknown dep'))).toBe(true);
  });
  it('flags self-deps', () => {
    const plan: Plan = {
      version: 1,
      tasks: [
        { id: '01', name: 'x', files: ['a.ts'], action: 'a', verify: 'v', done: 'd', deps: ['01'] }
      ]
    };
    const issues = checkPlan(plan);
    expect(issues.some((i) => i.message.includes('self-dep'))).toBe(true);
  });
  it('detects cycles', () => {
    const plan: Plan = {
      version: 1,
      tasks: [
        { id: '01', name: 'a', files: ['a.ts'], action: 'a', verify: 'v', done: 'd', deps: ['02'] },
        { id: '02', name: 'b', files: ['b.ts'], action: 'a', verify: 'v', done: 'd', deps: ['01'] }
      ]
    };
    const issues = checkPlan(plan);
    expect(issues.some((i) => i.message.includes('cycle'))).toBe(true);
  });
});

describe('workflow/plan: writePlan / readPlan', () => {
  let cwd: string;
  let state: TaskState;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'atlas-plan-'));
    const r = await startTask({ cwd, title: 'demo' });
    if (!r.ok) throw new Error('startTask failed');
    state = r.value;
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('writePlan rejects an invalid plan without writing the file', async () => {
    const bad: Plan = {
      version: 1,
      tasks: [
        { id: '01', name: 'a', files: ['a.ts'], action: 'a', verify: 'v', done: 'd', deps: ['ZZ'] }
      ]
    };
    const w = await writePlan(state, bad);
    expect(w.ok).toBe(false);
    const r = await readPlan(state);
    expect(r.ok && r.value).toBeNull();
  });

  it('writePlan + readPlan round trip', async () => {
    const w = await writePlan(state, samplePlan());
    expect(w.ok).toBe(true);
    const r = await readPlan(state);
    expect(r.ok).toBe(true);
    if (r.ok && r.value) expect(r.value).toEqual(samplePlan());
  });
});
