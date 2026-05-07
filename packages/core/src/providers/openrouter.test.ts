import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterProvider } from './openrouter.js';
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

const collect = async (
  stream: AsyncIterable<StreamEvent>
): Promise<readonly StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
};

describe('OpenRouter provider', () => {
  it('parses SSE deltas and emits a done event with usage', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        sseBody([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":", world"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
          'data: [DONE]\n\n'
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    );

    const provider = createOpenRouterProvider({
      apiKey: 'sk-test',
      fetch: fakeFetch as unknown as typeof fetch
    });

    const events = await collect(
      provider.stream({
        model: 'anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }]
      })
    );

    const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text);
    expect(deltas.join('')).toBe('Hello, world');

    const last = events.at(-1);
    expect(last?.type).toBe('done');
    if (last?.type === 'done') {
      expect(last.finishReason).toBe('stop');
      expect(last.usage?.totalTokens).toBe(5);
    }
  });

  it('handles SSE chunks split across read boundaries', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        sseBody([
          'data: {"choices":[{"delta":{"content":"A',
          'B"}}]}\n\ndata: {"choices":[{"delta":{"con',
          'tent":"C"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        ]),
        { status: 200 }
      )
    );

    const provider = createOpenRouterProvider({
      apiKey: 'sk-test',
      fetch: fakeFetch as unknown as typeof fetch
    });

    const events = await collect(
      provider.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }]
      })
    );

    const text = events
      .filter((e) => e.type === 'delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('ABC');
  });

  it('maps 401 to PROVIDER_AUTH_FAILED', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response('unauthorized', { status: 401 })
    );

    const provider = createOpenRouterProvider({
      apiKey: 'sk-bad',
      fetch: fakeFetch as unknown as typeof fetch
    });

    const events = await collect(
      provider.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }]
      })
    );

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.type).toBe('error');
    if (e?.type === 'error') expect(e.error.code).toBe('PROVIDER_AUTH_FAILED');
  });

  it('maps 429 to PROVIDER_RATE_LIMITED', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response('slow down', { status: 429 })
    );

    const provider = createOpenRouterProvider({
      apiKey: 'sk',
      fetch: fakeFetch as unknown as typeof fetch
    });

    const [first] = await collect(
      provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })
    );
    expect(first?.type).toBe('error');
    if (first?.type === 'error') expect(first.error.code).toBe('PROVIDER_RATE_LIMITED');
  });

  it('reports network errors', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const provider = createOpenRouterProvider({
      apiKey: 'sk',
      fetch: fakeFetch as unknown as typeof fetch
    });

    const [first] = await collect(
      provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })
    );
    expect(first?.type).toBe('error');
    if (first?.type === 'error') expect(first.error.code).toBe('PROVIDER_NETWORK');
  });

  it('honors AbortSignal during the request phase', async () => {
    const fakeFetch = vi.fn(async (_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal?.aborted) throw new Error('aborted');
      throw new Error('aborted'); // mimic fetch raising on abort
    });

    const ac = new AbortController();
    ac.abort();
    const provider = createOpenRouterProvider({
      apiKey: 'sk',
      fetch: fakeFetch as unknown as typeof fetch
    });

    const [first] = await collect(
      provider.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        signal: ac.signal
      })
    );
    expect(first?.type).toBe('error');
    if (first?.type === 'error') expect(first.error.code).toBe('CANCELLED');
  });

  it('sends the expected request body and headers', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(sseBody(['data: [DONE]\n\n']), { status: 200 })
    );

    const provider = createOpenRouterProvider({
      apiKey: 'sk-abc',
      referer: 'https://example.com',
      title: 'My App',
      fetch: fakeFetch as unknown as typeof fetch
    });

    await collect(
      provider.stream({
        model: 'anthropic/claude-sonnet-4',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' }
        ],
        temperature: 0.2,
        maxTokens: 100
      })
    );

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const opts = init as RequestInit;
    expect(opts.method).toBe('POST');
    const headers = opts.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-abc');
    expect(headers['http-referer']).toBe('https://example.com');
    expect(headers['x-title']).toBe('My App');
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('anthropic/claude-sonnet-4');
    expect(body['stream']).toBe(true);
    expect(body['temperature']).toBe(0.2);
    expect(body['max_tokens']).toBe(100);
  });

  it('assembles streaming tool_calls and emits a tool_call event', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        sseBody([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":"{\\"v\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hi\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n'
        ]),
        { status: 200 }
      )
    );

    const provider = createOpenRouterProvider({
      apiKey: 'sk-test',
      fetch: fakeFetch as unknown as typeof fetch
    });

    const events = await collect(
      provider.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'echo',
            description: 'd',
            parameters: { type: 'object', properties: { v: { type: 'string' } } }
          }
        ]
      })
    );

    const calls = events.flatMap((e) => (e.type === 'tool_call' ? [e.call] : []));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('echo');
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ v: 'hi' });
  });

  it('streams reasoning tokens as thinking events', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        sseBody([
          'data: {"choices":[{"delta":{"reasoning":"hmm"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3,"completion_tokens_details":{"reasoning_tokens":7}}}\n\n',
          'data: [DONE]\n\n'
        ]),
        { status: 200 }
      )
    );
    const provider = createOpenRouterProvider({
      apiKey: 'sk',
      fetch: fakeFetch as unknown as typeof fetch
    });
    const events = await collect(
      provider.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        reasoning: { effort: 'medium' }
      })
    );
    const thinking = events
      .flatMap((e) => (e.type === 'thinking' ? [e.text] : []))
      .join('');
    expect(thinking).toBe('hmm');
    const last = events.at(-1);
    if (last?.type === 'done') {
      expect(last.usage?.reasoningTokens).toBe(7);
    } else {
      throw new Error('expected done');
    }
  });

  it('forwards tools, tool_choice, and reasoning in the request body', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(sseBody(['data: [DONE]\n\n']), { status: 200 })
    );
    const provider = createOpenRouterProvider({
      apiKey: 'sk',
      fetch: fakeFetch as unknown as typeof fetch
    });
    await collect(
      provider.stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [
          { name: 't', description: 'd', parameters: { type: 'object', properties: {} } }
        ],
        toolChoice: 'auto',
        reasoning: { effort: 'high', maxTokens: 1024 }
      })
    );
    const init = fakeFetch.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const tools = body['tools'] as ReadonlyArray<Record<string, unknown>>;
    expect(tools[0]?.['type']).toBe('function');
    expect(body['tool_choice']).toBe('auto');
    expect(body['reasoning']).toEqual({ effort: 'high', max_tokens: 1024 });
  });

  it('serializes assistant tool_calls and tool-role replies on the wire', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(sseBody(['data: [DONE]\n\n']), { status: 200 })
    );
    const provider = createOpenRouterProvider({
      apiKey: 'sk',
      fetch: fakeFetch as unknown as typeof fetch
    });
    await collect(
      provider.stream({
        model: 'm',
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"v":"hi"}' }]
          },
          { role: 'tool', content: 'echo:hi', toolCallId: 'c1', name: 'echo' }
        ]
      })
    );
    const init = fakeFetch.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const messages = body['messages'] as ReadonlyArray<Record<string, unknown>>;
    expect(messages[1]?.['tool_calls']).toBeDefined();
    expect(messages[2]?.['tool_call_id']).toBe('c1');
  });

  it('blanks assistant content when toolCalls are present (prevents duplicate replies)', async () => {
    // Regression: feeding the model its own pre-tool narration back
    // alongside `tool_calls` causes some models to re-emit the same
    // prefix in the next round, surfacing as two ATLAS replies in a
    // row in the TUI. Canonical convention is content="" on assistant
    // messages with tool_calls.
    const fakeFetch = vi.fn(async () =>
      new Response(sseBody(['data: [DONE]\n\n']), { status: 200 })
    );
    const provider = createOpenRouterProvider({
      apiKey: 'sk',
      fetch: fakeFetch as unknown as typeof fetch
    });
    await collect(
      provider.stream({
        model: 'm',
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: 'Sure, let me look that up for you.',
            toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }]
          },
          { role: 'tool', content: 'ok', toolCallId: 'c1', name: 'echo' }
        ]
      })
    );
    const init = fakeFetch.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const messages = body['messages'] as ReadonlyArray<Record<string, unknown>>;
    expect(messages[1]?.['content']).toBe('');
    expect(messages[1]?.['tool_calls']).toBeDefined();
  });
});
