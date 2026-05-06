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
          supported_parameters: ['temperature', 'tools', 'reasoning'],
          pricing: { prompt: '0.0000015', completion: '0.000075', input_cache_read: '0.00000015' }
        },
        {
          id: 'openai/gpt-4o-mini',
          name: 'GPT-4o mini',
          supported_parameters: ['temperature', 'tools', 'prompt_cache_key'],
          pricing: { prompt: '0.00000015', completion: '0.0000006' }
        },
        {
          id: 'deepseek/deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          supported_parameters: ['temperature', 'tools', 'reasoning'],
          pricing: { prompt: '0.000000435', completion: '0.00000087', input_cache_read: '0.000000003625' }
        },
        {
          id: 'qwen/qwen3.5-plus-20260420',
          name: 'Qwen 3.5 Plus',
          supported_parameters: ['temperature', 'tools'],
          pricing: { prompt: '0.0000004', completion: '0.0000024' }
        }
      ]
    });
    const r = await fetchOpenRouterModels({ fetch: f, forceRefresh: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const opus = r.value.find((m) => m.id === 'anthropic/claude-opus-4.7');
    const gpt = r.value.find((m) => m.id === 'openai/gpt-4o-mini');
    const deepseek = r.value.find((m) => m.id === 'deepseek/deepseek-v4-pro');
    const qwen = r.value.find((m) => m.id === 'qwen/qwen3.5-plus-20260420');
    expect(opus?.thinking).toEqual(['off', 'low', 'medium', 'high']);
    expect(gpt?.thinking).toEqual(['off']);
    expect(opus?.promptCache).toBe('supported');
    expect(gpt?.promptCache).toBe('supported');
    expect(deepseek?.promptCache).toBe('supported');
    expect(qwen?.promptCache).toBe('unsupported');
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
    { id: 'anthropic/claude-opus-4.7', label: '', thinking: ['off', 'low', 'medium', 'high', 'xhigh'], promptCache: 'supported', provider: 'openrouter' },
    { id: 'claude-haiku-4-5', label: '', thinking: ['off', 'low', 'medium'], promptCache: 'supported', provider: 'anthropic' }
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
