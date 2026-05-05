/**
 * Tests for the `delegate` tool. We don't need a real provider — we
 * stub `delegateRun` directly on the ToolContext.
 */
import { describe, expect, it } from 'vitest';
import { delegateTool } from './delegate.js';
import type { DelegateRunFn, ToolContext } from './types.js';

const mkCtx = (
  delegateRun?: DelegateRunFn,
  depth = 0
): ToolContext => {
  const ctx: ToolContext = {
    cwd: process.cwd(),
    approve: { decide: () => ({ action: 'allow' }) },
    delegateDepth: depth
  };
  if (delegateRun) {
    return { ...ctx, delegateRun };
  }
  return ctx;
};

describe('delegateTool', () => {
  it('refuses when no runner is wired', async () => {
    const ctx = mkCtx();
    const r = await delegateTool.execute({ goal: 'do thing', maxConcurrent: 3 }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/not initialized/i);
    }
  });

  it('runs a single goal via the runner', async () => {
    const calls: { goal: string; agent?: string }[] = [];
    const run: DelegateRunFn = async (req) => {
      calls.push({ goal: req.goal, ...(req.agent !== undefined ? { agent: req.agent } : {}) });
      return { ok: true, summary: `did ${req.goal}`, rounds: 2, agent: req.agent ?? 'default' };
    };
    const r = await delegateTool.execute(
      { goal: 'fetch X', agent: 'hermes', maxConcurrent: 3 },
      mkCtx(run)
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ goal: 'fetch X', agent: 'hermes' }]);
    if (r.ok) {
      expect(r.value.summary).toContain('1/1 ok');
      expect(r.value.summary).toContain('did fetch X');
    }
  });

  it('passes the parent approval policy to child requests', async () => {
    const approvals: string[] = [];
    const run: DelegateRunFn = async (req) => {
      const decision = await req.approve?.decide('write_file', { path: 'x' });
      if (decision?.action === 'allow') approvals.push('allowed');
      return { ok: true, summary: 'done', rounds: 1 };
    };
    const ctx: ToolContext = {
      cwd: process.cwd(),
      approve: { decide: () => ({ action: 'allow' }) },
      delegateDepth: 0,
      delegateRun: run
    };

    const r = await delegateTool.execute({ goal: 'write x', maxConcurrent: 3 }, ctx);

    expect(r.ok).toBe(true);
    expect(approvals).toEqual(['allowed']);
  });

  it('runs batch tasks with bounded concurrency in input order', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const run: DelegateRunFn = async (req) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      inFlight -= 1;
      return { ok: true, summary: `r:${req.goal}`, rounds: 1 };
    };
    const r = await delegateTool.execute(
      {
        tasks: [
          { goal: 'a' },
          { goal: 'b' },
          { goal: 'c' },
          { goal: 'd' }
        ],
        maxConcurrent: 2
      },
      mkCtx(run)
    );
    expect(r.ok).toBe(true);
    expect(peakInFlight).toBeLessThanOrEqual(2);
    if (r.ok) {
      const data = r.value.data as { results: { idx: number; summary: string }[] };
      expect(data.results.map((x) => x.summary)).toEqual(['r:a', 'r:b', 'r:c', 'r:d']);
    }
  });

  it('refuses past depth limit', async () => {
    const run: DelegateRunFn = async () => ({ ok: true, summary: 'x', rounds: 0 });
    const r = await delegateTool.execute({ goal: 'g', maxConcurrent: 3 }, mkCtx(run, 2));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/depth limit/i);
  });

  it('rejects when both goal and tasks are provided', () => {
    const parsed = delegateTool.schema.safeParse({
      goal: 'a',
      tasks: [{ goal: 'b' }],
      maxConcurrent: 3
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects when neither goal nor tasks is provided', () => {
    const parsed = delegateTool.schema.safeParse({ maxConcurrent: 3 });
    expect(parsed.success).toBe(false);
  });

  it('reports per-task errors without aborting the batch', async () => {
    const run: DelegateRunFn = async (req) => {
      if (req.goal === 'b') return { ok: false, summary: 'oh no', error: 'oh no', rounds: 1 };
      return { ok: true, summary: `did ${req.goal}`, rounds: 1 };
    };
    const r = await delegateTool.execute(
      { tasks: [{ goal: 'a' }, { goal: 'b' }, { goal: 'c' }], maxConcurrent: 3 },
      mkCtx(run)
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toContain('2/3 ok');
      const data = r.value.data as { results: { ok: boolean }[] };
      expect(data.results.map((x) => x.ok)).toEqual([true, false, true]);
    }
  });
});
