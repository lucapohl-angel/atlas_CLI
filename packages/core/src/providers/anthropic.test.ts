import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from './anthropic.js';
import type { StreamEvent } from './types.js';

const sse = (events: ReadonlyArray<{ event: string; data: unknown }>): string =>
  events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');

const stringStream = (s: string): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(s));
      controller.close();
    }
  });
};

const collect = async (
  iter: AsyncIterable<StreamEvent>
): Promise<readonly StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
};

describe('createAnthropicProvider', () => {
  it('streams text deltas and a done event', async () => {
    const body = sse([
      { event: 'message_start', data: { message: { usage: { input_tokens: 4 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'text' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: ' world' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { usage: { output_tokens: 7 } } },
      { event: 'message_stop', data: {} }
    ]);

    let captured: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(stringStream(body), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      });
    };

    const provider = createAnthropicProvider({
      auth: { kind: 'apiKey', apiKey: 'sk-test' },
      fetch: fakeFetch
    });

    const events = await collect(
      provider.stream({
        model: 'claude-sonnet-4',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'hi' }
        ]
      })
    );

    const deltas = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text);
    expect(deltas.join('')).toBe('Hello world');

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();

    // System messages get hoisted to the top-level `system` field.
    expect(captured).not.toBeNull();
    const sentBody = JSON.parse((captured!.init.body as string) ?? '{}');
    expect(sentBody.system).toBe('You are helpful.');
    expect(Array.isArray(sentBody.messages)).toBe(true);
    expect(sentBody.messages[0].role).toBe('user');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
  });

  it('uses Bearer auth + oauth-beta header for OAuth tokens', async () => {
    const body = sse([{ event: 'message_stop', data: {} }]);
    let captured: { headers: Record<string, string> } | null = null;
    const fakeFetch: typeof fetch = async (_url, init) => {
      captured = { headers: (init?.headers ?? {}) as Record<string, string> };
      return new Response(stringStream(body), { status: 200 });
    };
    const provider = createAnthropicProvider({
      auth: { kind: 'oauth', accessToken: 'sk-ant-oat01-fake' },
      fetch: fakeFetch
    });
    await collect(
      provider.stream({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] })
    );
    expect(captured!.headers['authorization']).toBe('Bearer sk-ant-oat01-fake');
    expect(captured!.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(captured!.headers['x-api-key']).toBeUndefined();
  });

  it('emits a tool_call when a tool_use block completes', async () => {
    const body = sse([
      { event: 'message_start', data: { message: {} } },
      {
        event: 'content_block_start',
        data: { index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'echo' } }
      },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'input_json_delta', partial_json: '{"text":"hi"}' } }
      },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_stop', data: {} }
    ]);
    const provider = createAnthropicProvider({
      auth: { kind: 'apiKey', apiKey: 'sk' },
      fetch: async () => new Response(stringStream(body), { status: 200 })
    });
    const events = await collect(
      provider.stream({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] })
    );
    const tc = events.find((e) => e.type === 'tool_call');
    expect(tc).toBeDefined();
    if (tc?.type === 'tool_call') {
      expect(tc.call.id).toBe('tu_1');
      expect(tc.call.name).toBe('echo');
      expect(tc.call.arguments).toBe('{"text":"hi"}');
    }
  });

  it('maps non-2xx responses to a provider error event', async () => {
    const provider = createAnthropicProvider({
      auth: { kind: 'apiKey', apiKey: 'sk' },
      fetch: async () => new Response('rate limited', { status: 429 })
    });
    const events = await collect(
      provider.stream({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] })
    );
    const errEvt = events.find((e) => e.type === 'error');
    expect(errEvt).toBeDefined();
  });
});
