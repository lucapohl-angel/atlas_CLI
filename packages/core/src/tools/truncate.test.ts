import { describe, expect, it } from 'vitest';
import { truncateForLLM } from './truncate.js';

describe('truncateForLLM', () => {
  it('returns text unchanged when under budget', () => {
    expect(truncateForLLM('hello', { maxChars: 100 })).toBe('hello');
  });

  it('keeps head and tail with an elision marker', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
    const out = truncateForLLM(lines, { maxChars: 200, headRatio: 0.7 });
    expect(out.length).toBeLessThan(lines.length);
    expect(out).toMatch(/^line 0/);
    expect(out).toMatch(/line 999$/);
    expect(out).toMatch(/chars elided/);
  });

  it('respects custom marker', () => {
    const out = truncateForLLM('a'.repeat(1000), { maxChars: 100, marker: () => '\n[CUT]\n' });
    expect(out).toContain('[CUT]');
  });
});
