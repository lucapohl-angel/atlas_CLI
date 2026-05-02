import { describe, expect, it } from 'vitest';
import {
  canRewindTo,
  classifyIntent,
  formatPhaseLine,
  type PhaseSignals,
  type TaskState
} from './index.js';

const NO_SIGNALS: PhaseSignals = {
  hasContextDoc: false,
  hasPlanDoc: false,
  allTasksCommitted: false,
  allVerifyPassed: false
};

const mkTask = (phase: TaskState['phase']): TaskState => ({
  id: '20260101-000000-0000',
  title: 'sample',
  phase,
  cwd: '/tmp/sample',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
});

describe('classifyIntent', () => {
  it('starts a new task on a non-trivial message when none is active', () => {
    const r = classifyIntent({
      state: null,
      userMessage: 'Build me a CLI for managing my todos.',
      signals: NO_SIGNALS
    });
    expect(r.nextPhase).toBe('discover');
    expect(r.startsNewTask).toBe(true);
  });

  it('does not start a new task on a trivial message', () => {
    const r = classifyIntent({
      state: null,
      userMessage: 'ok',
      signals: NO_SIGNALS
    });
    expect(r.nextPhase).toBe('idle');
    expect(r.startsNewTask).toBeUndefined();
  });

  it('does not start a new task on a slash command', () => {
    const r = classifyIntent({
      state: null,
      userMessage: '/help',
      signals: NO_SIGNALS
    });
    expect(r.nextPhase).toBe('idle');
  });

  it('advances discover → plan when CONTEXT.md exists', () => {
    const r = classifyIntent({
      state: mkTask('discover'),
      userMessage: 'looks good',
      signals: { ...NO_SIGNALS, hasContextDoc: true }
    });
    expect(r.nextPhase).toBe('plan');
  });

  it('stays in discover without CONTEXT.md', () => {
    const r = classifyIntent({
      state: mkTask('discover'),
      userMessage: 'next question?',
      signals: NO_SIGNALS
    });
    expect(r.nextPhase).toBe('discover');
  });

  it('advances plan → execute when PLAN.xml exists', () => {
    const r = classifyIntent({
      state: mkTask('plan'),
      userMessage: 'go',
      signals: { ...NO_SIGNALS, hasContextDoc: true, hasPlanDoc: true }
    });
    expect(r.nextPhase).toBe('execute');
  });

  it('advances execute → verify when all tasks committed', () => {
    const r = classifyIntent({
      state: mkTask('execute'),
      userMessage: '',
      signals: { ...NO_SIGNALS, allTasksCommitted: true }
    });
    expect(r.nextPhase).toBe('verify');
  });

  it('advances verify → ship when all verify passed', () => {
    const r = classifyIntent({
      state: mkTask('verify'),
      userMessage: '',
      signals: { ...NO_SIGNALS, allVerifyPassed: true }
    });
    expect(r.nextPhase).toBe('ship');
  });

  it('stays in ship awaiting explicit action', () => {
    const r = classifyIntent({
      state: mkTask('ship'),
      userMessage: 'please',
      signals: { ...NO_SIGNALS, allVerifyPassed: true }
    });
    expect(r.nextPhase).toBe('ship');
  });
});

describe('canRewindTo', () => {
  it('rejects rewinding to the same phase', () => {
    const r = canRewindTo(mkTask('plan'), 'plan');
    expect(r.ok).toBe(false);
  });

  it('rejects forward jumps', () => {
    const r = canRewindTo(mkTask('discover'), 'execute');
    expect(r.ok).toBe(false);
  });

  it('allows backward jumps', () => {
    const r = canRewindTo(mkTask('execute'), 'plan');
    expect(r.ok).toBe(true);
  });
});

describe('formatPhaseLine', () => {
  it('formats idle when no task', () => {
    expect(formatPhaseLine(null)).toMatch(/idle/);
  });

  it('includes flags when signals are set', () => {
    const line = formatPhaseLine(mkTask('plan'), {
      ...NO_SIGNALS,
      hasContextDoc: true,
      hasPlanDoc: true
    });
    expect(line).toContain('plan');
    expect(line).toContain('CONTEXT.md');
    expect(line).toContain('PLAN.xml');
  });
});
