import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_HYBRID_TOOL_NAMES,
  LOCAL_LITE_TOOL_NAMES,
  createLocalProvider,
  listLocalModels,
  probeLocalProvider,
  __test__
} from './local.js';
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

describe('Local provider', () => {
  it('targets the OpenAI-compatible /chat/completions endpoint by default', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(sseBody(['data: [DONE]\n\n']), { status: 200 })
    );
    const provider = createLocalProvider({ fetch: fakeFetch as unknown as typeof fetch });

    await collect(
      provider.stream({ model: 'qwen2.5-coder:7b', messages: [{ role: 'user', content: 'hi' }] })
    );

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBeUndefined();
  });

  it('honors a custom baseUrl and apiKey', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(sseBody(['data: [DONE]\n\n']), { status: 200 })
    );
    const provider = createLocalProvider({
      baseUrl: 'http://lan-box:8000/v1/',
      apiKey: 'secret',
      fetch: fakeFetch as unknown as typeof fetch
    });

    await collect(
      provider.stream({ model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] })
    );

    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('http://lan-box:8000/v1/chat/completions');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer secret');
  });

  it('parses SSE deltas and emits a done event with usage', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        sseBody([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":", world"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
          'data: [DONE]\n\n'
        ]),
        { status: 200 }
      )
    );
    const provider = createLocalProvider({ fetch: fakeFetch as unknown as typeof fetch });

    const events = await collect(
      provider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    );

    const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    expect(text).toBe('Hello, world');
    const last = events.at(-1);
    expect(last?.type).toBe('done');
    if (last?.type === 'done') expect(last.usage?.totalTokens).toBe(5);
  });

  it('extracts <think>…</think> segments into thinking events', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        sseBody([
          'data: {"choices":[{"delta":{"content":"<think>reason"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"ing</think>final"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n'
        ]),
        { status: 200 }
      )
    );
    const provider = createLocalProvider({ fetch: fakeFetch as unknown as typeof fetch });

    const events = await collect(
      provider.stream({ model: 'deepseek-r1:7b', messages: [{ role: 'user', content: 'x' }] })
    );

    const thinking = events
      .filter((e) => e.type === 'thinking')
      .map((e) => e.text)
      .join('');
    const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    expect(thinking).toBe('reasoning');
    expect(deltas).toBe('final');
  });

  it('translates a network failure into a friendly hint about Ollama', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const provider = createLocalProvider({ fetch: fakeFetch as unknown as typeof fetch });

    const events = await collect(
      provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] })
    );

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe('error');
    if (e.type === 'error') {
      expect(e.error.code).toBe('PROVIDER_NETWORK');
      expect(e.error.message).toMatch(/ollama/i);
    }
  });

  it('maps a 404 to PROVIDER_MODEL_UNKNOWN with a pull hint', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response('model not found', { status: 404 })
    );
    const provider = createLocalProvider({ fetch: fakeFetch as unknown as typeof fetch });

    const events = await collect(
      provider.stream({ model: 'missing', messages: [{ role: 'user', content: 'x' }] })
    );

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe('error');
    if (e.type === 'error') {
      expect(e.error.code).toBe('PROVIDER_MODEL_UNKNOWN');
      expect(e.error.message).toMatch(/pull/i);
    }
  });

  it('forwards tool definitions and reassembles streamed tool calls', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        sseBody([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":"{\\"x\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n'
        ]),
        { status: 200 }
      )
    );
    const provider = createLocalProvider({ fetch: fakeFetch as unknown as typeof fetch });

    const events = await collect(
      provider.stream({
        model: 'qwen2.5-coder:7b',
        messages: [{ role: 'user', content: 'x' }],
        tools: [
          {
            name: 'echo',
            description: 'echo a value',
            parameters: { type: 'object', properties: { x: { type: 'number' } } }
          }
        ]
      })
    );

    const call = events.find((e) => e.type === 'tool_call');
    expect(call?.type).toBe('tool_call');
    if (call?.type === 'tool_call') {
      expect(call.call.name).toBe('echo');
      expect(call.call.arguments).toBe('{"x":1}');
    }

    const body = JSON.parse((fakeFetch.mock.calls[0]![1] as RequestInit).body as string) as {
      tools?: ReadonlyArray<{ type: string; function: { name: string } }>;
    };
    expect(body.tools?.[0]?.function.name).toBe('echo');
  });

  it('keeps Atlas identity and exact model self-knowledge in lite mode', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(sseBody(['data: [DONE]\n\n']), { status: 200 })
    );
    const provider = createLocalProvider({
      liteMode: true,
      fetch: fakeFetch as unknown as typeof fetch
    });

    expect(provider.supportsToolCalling).toBe(true);
    expect(provider.allowedToolNames).toEqual(LOCAL_LITE_TOOL_NAMES);

    await collect(
      provider.stream({
        model: 'qwen2.5-coder:7b',
        messages: [
          { role: 'system', content: 'full Atlas system prompt with tool catalog' },
          { role: 'user', content: 'which exact model are you?' }
        ],
        tools: [
          {
            name: 'read_file',
            description: 'read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } }
          }
        ]
      })
    );

    const body = JSON.parse((fakeFetch.mock.calls[0]![1] as RequestInit).body as string) as {
      messages: ReadonlyArray<{ role: string; content: string }>;
      tools?: ReadonlyArray<{ type: string; function: { name: string } }>;
    };
    expect(body.tools?.[0]?.function.name).toBe('read_file');
    expect(body.messages[0]?.content).toContain('You are Atlas');
    expect(body.messages[0]?.content).toContain('qwen2.5-coder:7b');
    expect(body.messages[0]?.content).toContain('Do not claim to be Claude');
    expect(body.messages[0]?.content).toContain('Local lite mode');
  });

  it('keeps a compact prompt while allowing tools in hybrid mode', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(sseBody(['data: [DONE]\n\n']), { status: 200 })
    );
    const provider = createLocalProvider({
      toolMode: 'hybrid',
      fetch: fakeFetch as unknown as typeof fetch
    });

    expect(provider.supportsToolCalling).toBe(true);
    expect(provider.allowedToolNames).toEqual(LOCAL_HYBRID_TOOL_NAMES);

    await collect(
      provider.stream({
        model: 'qwen2.5-coder:7b',
        messages: [
          { role: 'system', content: 'full Atlas system prompt with tool catalog' },
          { role: 'user', content: 'read package.json' }
        ],
        tools: [
          {
            name: 'read_file',
            description: 'read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } }
          }
        ]
      })
    );

    const body = JSON.parse((fakeFetch.mock.calls[0]![1] as RequestInit).body as string) as {
      messages: ReadonlyArray<{ role: string; content: string }>;
      tools?: ReadonlyArray<{ type: string; function: { name: string } }>;
    };
    expect(body.messages[0]?.content).toContain('You are Atlas');
    expect(body.messages[0]?.content).toContain('Local hybrid mode');
    expect(body.tools?.[0]?.function.name).toBe('read_file');
  });

  it('synthesises a tool call id when the local server omits it', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        sseBody([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"echo","arguments":"{\\"x\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n'
        ]),
        { status: 200 }
      )
    );
    const provider = createLocalProvider({ fetch: fakeFetch as unknown as typeof fetch });

    const events = await collect(
      provider.stream({
        model: 'qwen2.5-coder:7b',
        messages: [{ role: 'user', content: 'x' }],
        tools: [
          {
            name: 'echo',
            description: 'echo a value',
            parameters: { type: 'object', properties: { x: { type: 'number' } } }
          }
        ]
      })
    );

    const call = events.find((e) => e.type === 'tool_call');
    expect(call?.type).toBe('tool_call');
    if (call?.type === 'tool_call') {
      expect(call.call.name).toBe('echo');
      expect(call.call.arguments).toBe('{"x":1}');
      expect(call.call.id).toMatch(/^local_\d+_0$/);
    }
  });

  it('sends keep_alive only for Ollama endpoints', async () => {
    const fakeFetchOllama = vi.fn(async () =>
      new Response(sseBody(['data: [DONE]\n\n']), { status: 200 })
    );
    const ollamaProvider = createLocalProvider({
      fetch: fakeFetchOllama as unknown as typeof fetch
    });
    await collect(
      ollamaProvider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    );
    const ollamaBody = JSON.parse(
      (fakeFetchOllama.mock.calls[0]![1] as RequestInit).body as string
    ) as Record<string, unknown>;
    expect(ollamaBody.keep_alive).toBe('30m');

    const fakeFetchLmStudio = vi.fn(async () =>
      new Response(sseBody(['data: [DONE]\n\n']), { status: 200 })
    );
    const lmStudioProvider = createLocalProvider({
      baseUrl: 'http://localhost:1234/v1',
      fetch: fakeFetchLmStudio as unknown as typeof fetch
    });
    await collect(
      lmStudioProvider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    );
    const lmStudioBody = JSON.parse(
      (fakeFetchLmStudio.mock.calls[0]![1] as RequestInit).body as string
    ) as Record<string, unknown>;
    expect(lmStudioBody.keep_alive).toBeUndefined();
  });
});

describe('think extractor', () => {
  it('handles tags split across feeds', () => {
    const ext = __test__.createThinkExtractor();
    const a = ext.feed('plain<thi');
    expect(a.map((e) => ({ t: e.type, x: 'text' in e ? e.text : '' }))).toEqual([
      { t: 'delta', x: 'plain' }
    ]);
    const b = ext.feed('nk>secret</think>tail');
    const types = b.map((e) => e.type);
    expect(types).toEqual(['thinking', 'delta']);
  });

  it('emits thinking text inside an open <think> tag without waiting for the close tag', () => {
    const ext = __test__.createThinkExtractor();
    const events = ext.feed('<think>partial');
    expect(events).toEqual([{ type: 'thinking', text: 'partial' }]);
    // Subsequent close-tag arrival cleanly switches back to delta mode.
    const tail = ext.feed('</think>done');
    expect(tail).toEqual([{ type: 'delta', text: 'done' }]);
  });

  it('flushes a held-back partial-tag tail when the stream ends mid-tag', () => {
    const ext = __test__.createThinkExtractor();
    // `<thi` is a prefix of `<think>`, so it gets held back.
    const head = ext.feed('hello<thi');
    expect(head).toEqual([{ type: 'delta', text: 'hello' }]);
    const tail = ext.flush();
    expect(tail).toEqual([{ type: 'delta', text: '<thi' }]);
  });
});

describe('probeLocalProvider', () => {
  it('returns true when the server answers 200', async () => {
    const fakeFetch = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
    const ok = await probeLocalProvider('http://localhost:11434/v1', {
      fetch: fakeFetch as unknown as typeof fetch
    });
    expect(ok).toBe(true);
  });

  it('returns false when fetch throws', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new TypeError('refused');
    });
    const ok = await probeLocalProvider('http://localhost:11434/v1', {
      fetch: fakeFetch as unknown as typeof fetch
    });
    expect(ok).toBe(false);
  });
});

describe('listLocalModels', () => {
  it('parses the OpenAI /models response shape', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'qwen2.5-coder:7b' },
            { id: 'llama3.1:8b' },
            { id: '' },
            { other: 'ignored' }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const ids = await listLocalModels('http://localhost:11434/v1', {
      fetch: fakeFetch as unknown as typeof fetch
    });
    expect(ids).toEqual(['qwen2.5-coder:7b', 'llama3.1:8b']);
  });

  it('returns null on non-2xx', async () => {
    const fakeFetch = vi.fn(async () => new Response('nope', { status: 500 }));
    const ids = await listLocalModels('http://localhost:11434/v1', {
      fetch: fakeFetch as unknown as typeof fetch
    });
    expect(ids).toBeNull();
  });
});
