import { describe, expect, it } from 'vitest';
import {
  applyCompaction,
  approximateTokenCount,
  buildCompactPrompt,
  countMessageTokens,
  planCompaction
} from './window.js';
import type { Message } from '../providers/types.js';

describe('context window', () => {
  it('approximate tokenizer is roughly chars/4', () => {
    expect(approximateTokenCount('1234')).toBe(1);
    expect(approximateTokenCount('1234567890')).toBe(3);
  });

  it('keeps messages when well under threshold', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ];
    const r = planCompaction(msgs, { contextTokens: 1000 });
    expect(r.action).toBe('keep');
  });

  it('compacts older messages once threshold is exceeded', () => {
    const big = 'x'.repeat(4_000);
    const msgs: Message[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: big });
    }
    const r = planCompaction(msgs, { contextTokens: 5000, recentTurns: 4 });
    expect(r.action).toBe('compact');
    if (r.action !== 'compact') return;
    expect(r.olderToSummarize.length).toBe(6);
    expect(r.recentToKeep.length).toBe(4);
  });

  it('preserves system prefix during compaction', () => {
    const big = 'x'.repeat(4_000);
    const msgs: Message[] = [{ role: 'system', content: 'You are X.' }];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: big });
    }
    const r = planCompaction(msgs, { contextTokens: 5000, recentTurns: 4 });
    expect(r.action).toBe('compact');
    if (r.action !== 'compact') return;
    expect(r.recentToKeep[0]?.role).toBe('system');
  });

  it('counts message tokens including role overhead', () => {
    const msgs: Message[] = [{ role: 'user', content: 'abcd' }];
    expect(countMessageTokens(msgs)).toBe(5);
  });

  it('builds a compaction prompt that includes the transcript', () => {
    const out = buildCompactPrompt([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' }
    ]);
    expect(out).toContain('[user]: hi');
    expect(out).toContain('[assistant]: hey');
  });

  it('applyCompaction injects summary after system prompt', () => {
    const recent: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' }
    ];
    const out = applyCompaction(recent, 'previous goals: X');
    expect(out[0]?.role).toBe('system');
    expect(out[1]?.content).toContain('Previous conversation summary');
    expect(out[2]?.role).toBe('user');
  });
});
