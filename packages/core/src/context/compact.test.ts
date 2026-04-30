import { describe, expect, it } from 'vitest';
import { compactIfNeeded } from './compact.js';
import type { Message, Provider, StreamEvent } from '../providers/types.js';

const fakeProvider = (chunks: readonly string[]): Provider => ({
  name: 'fake',
  stream: async function* (): AsyncIterable<StreamEvent> {
    for (const t of chunks) yield { type: 'delta', text: t };
    yield { type: 'done', finishReason: 'stop' };
  }
});

describe('compactIfNeeded', () => {
  it('is a no-op below threshold', async () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ];
    const r = await compactIfNeeded(msgs, {
      provider: fakeProvider(['SUMMARY']),
      summarizerModel: 'm',
      limits: { contextTokens: 100_000 }
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.compacted).toBe(false);
      expect(r.value.messages).toEqual(msgs);
    }
  });

  it('summarizes older turns above threshold', async () => {
    const big = 'x'.repeat(40_000);
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' }
    ];
    const r = await compactIfNeeded(msgs, {
      provider: fakeProvider(['THE ', 'SUMMARY']),
      summarizerModel: 'm',
      limits: { contextTokens: 10_000 }
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.compacted).toBe(true);
      expect(r.value.summarized).toBeGreaterThan(0);
      const sysMsgs = r.value.messages.filter((m) => m.role === 'system');
      expect(sysMsgs.some((m) => m.content.includes('THE SUMMARY'))).toBe(true);
      expect(r.value.messages.length).toBeLessThan(msgs.length);
    }
  });

  it('returns err if the summarizer stream errors', async () => {
    const big = 'x'.repeat(40_000);
    const msgs: Message[] = Array.from({ length: 9 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: big
    }));
    const provider: Provider = {
      name: 'fail',
      stream: async function* (): AsyncIterable<StreamEvent> {
        yield {
          type: 'error',
          error: { code: 'PROVIDER_ERROR', message: 'boom' }
        };
      }
    };
    const r = await compactIfNeeded(msgs, {
      provider,
      summarizerModel: 'm',
      limits: { contextTokens: 10_000 }
    });
    expect(r.ok).toBe(false);
  });
});
