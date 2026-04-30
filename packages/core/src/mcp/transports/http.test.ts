/**
 * HTTP transport tests — fetch is mocked at the global scope so we can
 * cover the JSON-response, SSE-response, 202-notification, and 404
 * session-expiry branches without spinning up a real server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from './http.js';

describe('HttpTransport', () => {
  const url = 'https://example.test/mcp';
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const resp = (
    body: string,
    init: { status?: number; headers?: Record<string, string> } = {}
  ): Response =>
    new Response(body, {
      status: init.status ?? 200,
      headers: init.headers ?? { 'content-type': 'application/json' }
    });

  it('round-trips a JSON-RPC request via plain JSON response', async () => {
    fetchSpy.mockResolvedValueOnce(
      resp(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
    );
    const t = new HttpTransport({ name: 'x', url });
    const start = await t.start();
    expect(start.ok).toBe(true);
    const r = await t.request('tools/list', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const call = fetchSpy.mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)['accept']).toContain('text/event-stream');
  });

  it('parses SSE response and finds the matching id', async () => {
    const sse =
      `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"value":42}}\n\n`;
    fetchSpy.mockResolvedValueOnce(
      resp(sse, { headers: { 'content-type': 'text/event-stream' } })
    );
    const t = new HttpTransport({ name: 'x', url });
    await t.start();
    const r = await t.request('tools/list', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ value: 42 });
  });

  it('treats 202 with no body as a successful notification', async () => {
    fetchSpy.mockResolvedValueOnce(resp('', { status: 202, headers: {} }));
    const t = new HttpTransport({ name: 'x', url });
    await t.start();
    const r = await t.notify('notifications/initialized', {});
    expect(r.ok).toBe(true);
  });

  it('drops session id on 404 and returns an error', async () => {
    // First call: server mints a session id.
    fetchSpy.mockResolvedValueOnce(
      resp(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-abc' }
      })
    );
    // Second call: server forgot us.
    fetchSpy.mockResolvedValueOnce(resp('', { status: 404, headers: {} }));
    const t = new HttpTransport({ name: 'x', url });
    await t.start();
    const first = await t.request('tools/list', {});
    expect(first.ok).toBe(true);
    const second = await t.request('tools/list', {});
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toContain('expired');
    // Third call should not include the dropped session id.
    fetchSpy.mockResolvedValueOnce(
      resp(JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} }))
    );
    await t.request('tools/list', {});
    const init = fetchSpy.mock.calls[2]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['mcp-session-id']).toBeUndefined();
  });

  it('forwards static auth headers', async () => {
    fetchSpy.mockResolvedValueOnce(
      resp(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }))
    );
    const t = new HttpTransport({
      name: 'x',
      url,
      headers: { Authorization: 'Bearer secret' }
    });
    await t.start();
    await t.request('tools/list', {});
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret');
  });
});
