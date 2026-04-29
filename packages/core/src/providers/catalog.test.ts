import { describe, it, expect } from 'vitest';
import { fetchOpenRouterModels, thinkingLevelsFor, type ModelInfo } from './catalog.js';

const makeFetch = (status: number, body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch;

describe('fetchOpenRouterModels', () => {
  it('parses ids + reasoning support', async () => {
    const f = makeFetch(200, {
      data: [
        {
          id: 'anthropic/claude-opus-4.7',
          name: 'Claude Opus 4.7',
          context_length: 200_000,
          supported_parameters: ['temperature', 'tools', 'reasoning']
        },
        {
          id: 'openai/gpt-4o-mini',
          name: 'GPT-4o mini',
          supported_parameters: ['temperature', 'tools']
        }
      ]
    });
    const r = await fetchOpenRouterModels({ fetch: f, forceRefresh: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const opus = r.value.find((m) => m.id === 'anthropic/claude-opus-4.7');
    const gpt = r.value.find((m) => m.id === 'openai/gpt-4o-mini');
    expect(opus?.thinking).toEqual(['off', 'low', 'medium', 'high']);
    expect(gpt?.thinking).toEqual(['off']);
    expect(opus?.contextWindow).toBe(200_000);
  });

  it('returns error on HTTP failure', async () => {
    const f = makeFetch(500, { error: 'oops' });
    const r = await fetchOpenRouterModels({ fetch: f, forceRefresh: true });
    expect(r.ok).toBe(false);
  });
});

describe('thinkingLevelsFor', () => {
  const catalog: ModelInfo[] = [
    { id: 'anthropic/claude-opus-4.7', label: '', thinking: ['off', 'low', 'medium', 'high', 'xhigh'], provider: 'openrouter' },
    { id: 'claude-haiku-4-5', label: '', thinking: ['off', 'low', 'medium'], provider: 'anthropic' }
  ];
  it('exact match', () => {
    expect(thinkingLevelsFor('anthropic/claude-opus-4.7', catalog)).toEqual([
      'off', 'low', 'medium', 'high', 'xhigh'
    ]);
  });
  it('strips provider prefix', () => {
    expect(thinkingLevelsFor('anthropic/claude-haiku-4-5', catalog)).toEqual([
      'off', 'low', 'medium'
    ]);
  });
  it('regex fallback for unknown claude id', () => {
    expect(thinkingLevelsFor('claude-opus-4-7', [])).toEqual([
      'off', 'low', 'medium', 'high', 'xhigh'
    ]);
  });
  it('regex fallback for unknown openai reasoning id', () => {
    expect(thinkingLevelsFor('openai/gpt-5-pro', [])).toEqual(['off', 'low', 'medium', 'high']);
  });
  it('off-only for unknown non-reasoning id', () => {
    expect(thinkingLevelsFor('mistral/mistral-large', [])).toEqual(['off']);
  });
});
