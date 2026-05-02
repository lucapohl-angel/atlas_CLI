import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHooks } from '../registry.js';
import { HookRegistry } from '../registry.js';
import {
  contradictionHook,
  countQuestions,
  detectContradictions,
  isVagueUserMessage,
  multiQuestionHook,
  vaguenessHook
} from './discover-guardrails.js';
import { consumeDiscoverWarnings } from '../../workflow/discover-warnings.js';
import { emptySlots, setSlot } from '../../workflow/slots.js';
import { startTask, updateTask } from '../../workflow/state.js';
import type { TaskState } from '../../workflow/types.js';

describe('discover-guardrails: pure helpers', () => {
  it('isVagueUserMessage flags idk-style replies', () => {
    expect(isVagueUserMessage('idk')).toBe(true);
    expect(isVagueUserMessage("i don't know")).toBe(true);
    expect(isVagueUserMessage('you decide')).toBe(true);
    expect(isVagueUserMessage('whatever')).toBe(true);
    expect(isVagueUserMessage('ok')).toBe(true);
    expect(isVagueUserMessage('sure')).toBe(true);
    expect(isVagueUserMessage("doesn't matter")).toBe(true);
  });

  it('isVagueUserMessage allows substantive replies', () => {
    expect(isVagueUserMessage('use Postgres with bcrypt for hashing')).toBe(false);
    expect(isVagueUserMessage('REST + Express, please.')).toBe(false);
    expect(isVagueUserMessage('')).toBe(false);
  });

  it('detectContradictions catches perf antonym pair', () => {
    const slots = {
      ...emptySlots(),
      successCriteria: ['must respond in under 100ms']
    };
    const hits = detectContradictions("performance doesn't matter, slow ok", slots);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.label).toBe('performance');
  });

  it('detectContradictions returns nothing on unrelated content', () => {
    const slots = { ...emptySlots(), goal: 'Ship a receipts API' };
    const hits = detectContradictions('add a webhooks module', slots);
    expect(hits).toEqual([]);
  });

  it('countQuestions counts every "?"', () => {
    expect(countQuestions('what stack? which db? auth?')).toBe(3);
    expect(countQuestions('what is the goal?')).toBe(1);
    expect(countQuestions('no questions here.')).toBe(0);
  });
});

describe('discover-guardrails: hooks (file-backed)', () => {
  let cwd: string;
  let state: TaskState;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'atlas-dg-'));
    const r = await startTask({ cwd, title: 'demo' });
    if (!r.ok) throw new Error('startTask');
    state = r.value;
    // The hooks only fire in the discover phase. New tasks start in
    // 'idle' per the router; nudge it to 'discover' for these tests.
    const u = await updateTask(state, { phase: 'discover' });
    if (!u.ok) throw new Error('updateTask');
    state = u.value;
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('vaguenessHook blocks context_set when last user message was vague', async () => {
    const reg = new HookRegistry();
    reg.register(vaguenessHook(cwd));
    const r = await runHooks(reg, 'beforeTool', {
      event: 'beforeTool',
      tool: 'context_set',
      input: { slot: 'goal', content: 'Use Postgres' },
      lastUserMessage: 'idk'
    });
    expect(r.action).toBe('block');
    if (r.action === 'block') {
      expect(r.reason).toContain('vague');
      expect(r.reason).toContain('clarify');
    }
  });

  it('vaguenessHook allows when last user message is substantive', async () => {
    const reg = new HookRegistry();
    reg.register(vaguenessHook(cwd));
    const r = await runHooks(reg, 'beforeTool', {
      event: 'beforeTool',
      tool: 'context_set',
      input: { slot: 'goal', content: 'Use Postgres' },
      lastUserMessage: 'use Postgres for the receipts table, with a bcrypt password hash'
    });
    expect(r.action).toBe('allow');
  });

  it('vaguenessHook only matches context_set', async () => {
    const reg = new HookRegistry();
    reg.register(vaguenessHook(cwd));
    const r = await runHooks(reg, 'beforeTool', {
      event: 'beforeTool',
      tool: 'context_note',
      input: { heading: 'x', body: 'y' },
      lastUserMessage: 'idk'
    });
    expect(r.action).toBe('allow');
  });

  it('contradictionHook blocks on perf antonym vs an existing success bullet', async () => {
    await setSlot(state, 'success', 'must respond in under 100ms');
    const reg = new HookRegistry();
    reg.register(contradictionHook(cwd));
    const r = await runHooks(reg, 'beforeTool', {
      event: 'beforeTool',
      tool: 'context_set',
      input: { slot: 'constraints', content: "performance doesn't matter, slow ok" }
    });
    expect(r.action).toBe('block');
    if (r.action === 'block') {
      expect(r.reason).toContain('contradiction');
      expect(r.reason).toContain('performance');
    }
  });

  it('contradictionHook allows non-conflicting writes', async () => {
    await setSlot(state, 'goal', 'Ship a receipts API');
    const reg = new HookRegistry();
    reg.register(contradictionHook(cwd));
    const r = await runHooks(reg, 'beforeTool', {
      event: 'beforeTool',
      tool: 'context_set',
      input: { slot: 'constraints', content: 'TypeScript strict, no any' }
    });
    expect(r.action).toBe('allow');
  });

  it('multiQuestionHook appends a warning when assistant asked >1 question', async () => {
    const reg = new HookRegistry();
    reg.register(multiQuestionHook(cwd));
    const r = await runHooks(reg, 'afterMessage', {
      event: 'afterMessage',
      role: 'assistant',
      content: 'What stack? Which database? Need auth?'
    });
    expect(r.action).toBe('allow');
    const warnings = await consumeDiscoverWarnings(state);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('3 question');
  });

  it('multiQuestionHook stays quiet on a single-question turn', async () => {
    const reg = new HookRegistry();
    reg.register(multiQuestionHook(cwd));
    await runHooks(reg, 'afterMessage', {
      event: 'afterMessage',
      role: 'assistant',
      content: 'What is the goal?'
    });
    const warnings = await consumeDiscoverWarnings(state);
    expect(warnings).toEqual([]);
  });

  it('multiQuestionHook ignores user-role messages', async () => {
    const reg = new HookRegistry();
    reg.register(multiQuestionHook(cwd));
    await runHooks(reg, 'afterMessage', {
      event: 'afterMessage',
      role: 'user',
      content: 'why? what? where?'
    });
    const warnings = await consumeDiscoverWarnings(state);
    expect(warnings).toEqual([]);
  });
});
