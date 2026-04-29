import { describe, expect, it, vi } from 'vitest';
import { HookRegistry, runHooks } from './registry.js';

describe('hook system', () => {
  it('returns allow when no hooks are registered', async () => {
    const r = await runHooks(new HookRegistry(), 'beforeMessage', {
      event: 'beforeMessage',
      role: 'user',
      content: 'hi'
    });
    expect(r.action).toBe('allow');
  });

  it('runs hooks in registration order', async () => {
    const order: number[] = [];
    const reg = new HookRegistry();
    reg.register({
      event: 'beforeMessage',
      handler: () => {
        order.push(1);
        return { action: 'allow' };
      }
    });
    reg.register({
      event: 'beforeMessage',
      handler: () => {
        order.push(2);
        return { action: 'allow' };
      }
    });
    await runHooks(reg, 'beforeMessage', { event: 'beforeMessage', role: 'user', content: 'x' });
    expect(order).toEqual([1, 2]);
  });

  it('block short-circuits later hooks', async () => {
    const later = vi.fn(() => ({ action: 'allow' as const }));
    const reg = new HookRegistry();
    reg.register({
      event: 'beforeTool',
      handler: () => ({ action: 'block', reason: 'no terminal in CI' })
    });
    reg.register({ event: 'beforeTool', handler: later });
    const r = await runHooks(reg, 'beforeTool', {
      event: 'beforeTool',
      tool: 'terminal',
      input: { command: 'ls' }
    });
    expect(r.action).toBe('block');
    expect(later).not.toHaveBeenCalled();
  });

  it('matcher restricts hook to a tool', async () => {
    const calls: string[] = [];
    const reg = new HookRegistry();
    reg.register({
      event: 'beforeTool',
      matcher: 'terminal',
      handler: (c) => {
        calls.push(c.tool);
        return { action: 'allow' };
      }
    });
    await runHooks(reg, 'beforeTool', { event: 'beforeTool', tool: 'read_file', input: {} });
    await runHooks(reg, 'beforeTool', { event: 'beforeTool', tool: 'terminal', input: {} });
    expect(calls).toEqual(['terminal']);
  });

  it('modify is preserved across remaining hooks', async () => {
    const reg = new HookRegistry();
    reg.register({
      event: 'beforeMessage',
      handler: () => ({ action: 'modify', payload: { redacted: true } })
    });
    reg.register({ event: 'beforeMessage', handler: () => ({ action: 'allow' }) });
    const r = await runHooks(reg, 'beforeMessage', {
      event: 'beforeMessage',
      role: 'user',
      content: 'x'
    });
    expect(r.action).toBe('modify');
  });

  it('a thrown handler is converted into block', async () => {
    const reg = new HookRegistry();
    reg.register({
      event: 'sessionStart',
      handler: () => {
        throw new Error('boom');
      }
    });
    const r = await runHooks(reg, 'sessionStart', { event: 'sessionStart', sessionId: 's' });
    expect(r.action).toBe('block');
    if (r.action === 'block') expect(r.reason).toContain('boom');
  });
});
