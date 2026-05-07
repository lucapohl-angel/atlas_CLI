import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeProvider, openCodeRouteForModel } from './opencode.js';
import type { StreamEvent } from './types.js';

const sseBody = (chunks: readonly string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
};

const collect = async (stream: AsyncIterable<StreamEvent>): Promise<readonly StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
};

describe('openCodeRouteForModel', () => {
  it('routes documented Zen and Go model families', () => {
    expect(openCodeRouteForModel('zen', 'opencode/gpt-5.5')).toBe('responses');
    expect(openCodeRouteForModel('zen', 'opencode/claude-sonnet-4-6')).toBe('messages');
    expect(openCodeRouteForModel('zen', 'opencode/qwen3.6-plus')).toBe('chat-completions');
    expect(openCodeRouteForModel('go', 'opencode-go/minimax-m2.7')).toBe('messages');
    expect(openCodeRouteForModel('go', 'opencode-go/kimi-k2.6')).toBe('chat-completions');
    expect(openCodeRouteForModel('zen', 'opencode/gemini-3-flash')).toBeNull();
  });
});

describe('OpenCode provider', () => {
  it('sends Bearer auth, strips prefix, and routes Zen GPT to /responses', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        sseBody([
          'event: response.output_text.delta\n',
          'data: {"delta":"hi"}\n\n',
          'event: response.completed\n',
          'data: {"response":{"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n'
        ]),
        { status: 200 }
      )
    );
    const provider = createOpenCodeProvider({
      plan: 'zen',
      apiKey: 'zen-key',
      baseUrl: 'https://example.test/zen/v1/',
      fetch: fakeFetch as unknown as typeof fetch
    });
    const events = await collect(provider.stream({ model: 'opencode/gpt-5.5', messages: [{ role: 'user', content: 'x' }] }));
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('https://example.test/zen/v1/responses');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer zen-key');
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-5.5');
    expect(events.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toBe('hi');
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') expect(done.usage?.totalTokens).toBe(3);
  });

  it('routes Zen Claude to /messages and emits tool calls', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        sseBody([
          'event: content_block_start\n',
          'data: {"index":0,"content_block":{"type":"tool_use","id":"t1","name":"echo"}}\n\n',
          'event: content_block_delta\n',
          'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"v\\":\\"hi\\"}"}}\n\n',
          'event: content_block_stop\n',
          'data: {"index":0}\n\n',
          'event: message_stop\n',
          'data: {}\n\n'
        ]),
        { status: 200 }
      )
    );
    const provider = createOpenCodeProvider({ plan: 'zen', apiKey: 'k', fetch: fakeFetch as unknown as typeof fetch });
    const events = await collect(provider.stream({ model: 'opencode/claude-sonnet-4-6', messages: [{ role: 'user', content: 'x' }] }));
    const [url] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('https://opencode.ai/zen/v1/messages');
    const calls = events.flatMap((e) => (e.type === 'tool_call' ? [e.call] : []));
    expect(calls[0]).toEqual({ id: 't1', name: 'echo', arguments: '{"v":"hi"}' });
  });

  it('routes Go chat models to /chat/completions and emits tool calls', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        sseBody([
          'data: {"choices":[{"delta":{"content":"ok","tool_calls":[{"index":0,"id":"c1","function":{"name":"echo","arguments":"{\\"v\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hi\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n'
        ]),
        { status: 200 }
      )
    );
    const provider = createOpenCodeProvider({ plan: 'go', apiKey: 'k', fetch: fakeFetch as unknown as typeof fetch });
    const events = await collect(provider.stream({ model: 'opencode-go/kimi-k2.6', messages: [{ role: 'user', content: 'x' }] }));
    const [url] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(events.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toBe('ok');
    const calls = events.flatMap((e) => (e.type === 'tool_call' ? [e.call] : []));
    expect(calls[0]?.name).toBe('echo');
  });

  it('maps 401 and 429 to provider errors', async () => {
    const authFetch = vi.fn(async () => new Response('bad', { status: 401 }));
    const rateFetch = vi.fn(async () => new Response('slow', { status: 429 }));
    const authProvider = createOpenCodeProvider({ plan: 'go', apiKey: 'k', fetch: authFetch as unknown as typeof fetch });
    const rateProvider = createOpenCodeProvider({ plan: 'go', apiKey: 'k', fetch: rateFetch as unknown as typeof fetch });
    const [auth] = await collect(authProvider.stream({ model: 'opencode-go/kimi-k2.6', messages: [{ role: 'user', content: 'x' }] }));
    const [rate] = await collect(rateProvider.stream({ model: 'opencode-go/kimi-k2.6', messages: [{ role: 'user', content: 'x' }] }));
    expect(auth?.type).toBe('error');
    if (auth?.type === 'error') expect(auth.error.code).toBe('PROVIDER_AUTH_FAILED');
    expect(rate?.type).toBe('error');
    if (rate?.type === 'error') expect(rate.error.code).toBe('PROVIDER_RATE_LIMITED');
  });

  it('blanks assistant content when toolCalls are present (chat-completions wire format)', async () => {
    // Regression: third-party Chat Completions models (DeepSeek/GLM/
    // Kimi/Qwen) re-emit the prior round's pre-tool narration when
    // we feed it back alongside `tool_calls`, producing duplicate
    // ATLAS replies. The canonical convention is content="" on
    // assistant messages with tool_calls.
    const fakeFetch = vi.fn(
      async () => new Response(sseBody(['data: [DONE]\n\n']), { status: 200 })
    );
    const provider = createOpenCodeProvider({
      plan: 'go',
      apiKey: 'k',
      fetch: fakeFetch as unknown as typeof fetch
    });
    await collect(
      provider.stream({
        model: 'opencode-go/kimi-k2.6',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: "Okay, I'll check that for you.",
            toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"v":"hi"}' }]
          },
          { role: 'tool', content: 'result', toolCallId: 'c1', name: 'echo' }
        ]
      })
    );
    const [, init] = fakeFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      messages: ReadonlyArray<{ role: string; content: unknown; tool_calls?: unknown }>;
    };
    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('');
    expect(assistant?.tool_calls).toBeDefined();
  });

  it('honors AbortSignal during request', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('aborted');
    });
    const ac = new AbortController();
    ac.abort();
    const provider = createOpenCodeProvider({ plan: 'go', apiKey: 'k', fetch: fakeFetch as unknown as typeof fetch });
    const [event] = await collect(
      provider.stream({ model: 'opencode-go/kimi-k2.6', messages: [{ role: 'user', content: 'x' }], signal: ac.signal })
    );
    expect(event?.type).toBe('error');
    if (event?.type === 'error') expect(event.error.code).toBe('CANCELLED');
  });
});
