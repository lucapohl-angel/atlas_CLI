import { describe, expect, it } from 'vitest';
import {
  buildReflectionMessages,
  describeLearnReason,
  parseLearnedSkillDraft,
  shouldOfferLearn
} from './learn.js';

describe('shouldOfferLearn', () => {
  it('triggers on many rounds', () => {
    expect(shouldOfferLearn(5, 0, 'ok')).toBe(true);
    expect(shouldOfferLearn(4, 0, 'ok')).toBe(false);
  });
  it('triggers on repeated tool errors', () => {
    expect(shouldOfferLearn(2, 2, 'ok')).toBe(true);
  });
  it('triggers on success phrase after struggle', () => {
    expect(shouldOfferLearn(3, 0, 'finally works thanks')).toBe(true);
    expect(shouldOfferLearn(1, 0, 'works now')).toBe(false);
  });
  it('does not trigger on normal turns', () => {
    expect(shouldOfferLearn(2, 0, 'cool thanks')).toBe(false);
  });
});

describe('describeLearnReason', () => {
  it('lists matching reasons', () => {
    expect(describeLearnReason(6, 3, 'works now')).toContain('6 rounds');
    expect(describeLearnReason(6, 3, 'works now')).toContain('3 tool errors');
    expect(describeLearnReason(6, 3, 'works now')).toContain('user signalled success');
  });
  it('falls back to manual', () => {
    expect(describeLearnReason(0, 0, '')).toBe('manual /learn');
  });
});

describe('buildReflectionMessages', () => {
  it('strips system messages and caps recent turns', () => {
    const history = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `m${i}`
    }));
    history.unshift({ role: 'user' as const, content: 'sysmsg' });
    const out = buildReflectionMessages(history, 'manual', { recentTurnsCap: 4 });
    // 1 reflection system + 4 recent + 1 user instruction = 6
    expect(out).toHaveLength(6);
    expect(out[0]?.role).toBe('system');
    expect(out[out.length - 1]?.content).toContain('Trigger reason: manual');
  });
  it('truncates very long messages', () => {
    const big = 'x'.repeat(5000);
    const out = buildReflectionMessages(
      [{ role: 'user', content: big }],
      'manual',
      { perMessageCharCap: 100 }
    );
    expect(out[1]?.content.length).toBeLessThan(200);
    expect(out[1]?.content).toContain('[truncated]');
  });
});

describe('parseLearnedSkillDraft', () => {
  it('returns null for the literal null token', () => {
    const r = parseLearnedSkillDraft('null');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.draft).toBeNull();
  });
  it('parses a valid JSON draft', () => {
    const json = '{"name":"x-y","description":"d","triggers":["a"],"body":"# h"}';
    const r = parseLearnedSkillDraft(json);
    expect(r.ok).toBe(true);
    if (r.ok && r.draft) {
      expect(r.draft.name).toBe('x-y');
      expect(r.draft.triggers).toEqual(['a']);
    }
  });
  it('strips fenced code blocks', () => {
    const fenced = '```json\n{"name":"x","description":"d","triggers":[],"body":"b"}\n```';
    const r = parseLearnedSkillDraft(fenced);
    expect(r.ok).toBe(true);
  });
  it('rejects drafts missing required fields', () => {
    const r = parseLearnedSkillDraft('{"name":"x"}');
    expect(r.ok).toBe(false);
  });
  it('rejects invalid JSON', () => {
    const r = parseLearnedSkillDraft('not json');
    expect(r.ok).toBe(false);
  });
});
