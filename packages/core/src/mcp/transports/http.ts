/**
 * Streamable HTTP transport for MCP (spec 2025-03-26).
 *
 *   - Every JSON-RPC request is a fresh `POST` to the configured MCP
 *     endpoint with `Accept: application/json, text/event-stream`.
 *   - Servers respond either with a single JSON object (the response)
 *     or with an `text/event-stream` SSE stream that eventually carries
 *     the matching JSON-RPC response. We support both.
 *   - Sessions: when the server returns `Mcp-Session-Id` on
 *     `initialize`, every subsequent request echoes it back. On HTTP
 *     404 we drop the id so the next call re-initializes.
 *   - Authentication is header-based: callers pass `headers` with
 *     `Authorization: Bearer ...` or whatever the server requires.
 *     Full OAuth 2.1 device flow is out of scope for this slice — most
 *     hosted MCP servers (Higgsfield, Figma) accept a long-lived
 *     personal token in a header, which is enough to ship.
 *
 * Notes on what we deliberately do NOT support yet:
 *   - GET-initiated server-pushed notifications (long-poll SSE).
 *   - Stream resumption via `Last-Event-ID`.
 *   - Server-to-client requests (we drop them on the floor).
 *   - Session termination via `DELETE` (we just stop using the id).
 *
 * These are all upgrade points if a server we care about needs them.
 */
import { atlasError, type AtlasError } from '../../errors.js';
import { childLogger } from '../../logger.js';
import { err, ok, type Result } from '../../result.js';
import type { JsonRpcMessage, McpTransport } from './types.js';

const log = childLogger('mcp.http');

export interface HttpTransportSpec {
  readonly name: string;
  readonly url: string;
  /** Static headers (e.g. `Authorization: Bearer ...`). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Per-request timeout in ms. Default 30s. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpTransport implements McpTransport {
  private nextId = 1;
  private sessionId: string | null = null;
  private stopped = false;

  constructor(private readonly spec: HttpTransportSpec) {}

  async start(signal?: AbortSignal): Promise<Result<void, AtlasError>> {
    // HTTP has no persistent connection to open at the transport layer
    // — the first POST happens during `initialize`. We just validate
    // that the URL parses so we fail fast on misconfiguration.
    try {
      new URL(this.spec.url);
    } catch (e) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `invalid MCP HTTP url for ${this.spec.name}`, {
          cause: e
        })
      );
    }
    signal?.addEventListener('abort', () => this.stop(), { once: true });
    return ok(undefined);
  }

  async request(method: string, params: unknown): Promise<Result<unknown, AtlasError>> {
    if (this.stopped) {
      return err(atlasError('TOOL_EXECUTION_FAILED', `MCP HTTP transport stopped: ${this.spec.name}`));
    }
    const id = this.nextId++;
    const msg: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    return this.post(msg, id);
  }

  async notify(method: string, params: unknown): Promise<Result<void, AtlasError>> {
    if (this.stopped) return ok(undefined);
    const msg: JsonRpcMessage = { jsonrpc: '2.0', method, params };
    const r = await this.post(msg, null);
    return r.ok ? ok(undefined) : err(r.error);
  }

  stop(): void {
    this.stopped = true;
    this.sessionId = null;
  }

  private async post(
    msg: JsonRpcMessage,
    expectId: number | string | null
  ): Promise<Result<unknown, AtlasError>> {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), this.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.spec.headers ?? {})
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    let res: Response;
    try {
      res = await fetch(this.spec.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(msg),
        signal: ac.signal
      });
    } catch (e) {
      clearTimeout(timeout);
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `MCP HTTP request failed: ${(e as Error).message}`, {
          cause: e
        })
      );
    }

    // The server may have minted a session id on initialize. Per spec
    // we echo it on every subsequent request.
    const echoed = res.headers.get('mcp-session-id');
    if (echoed) this.sessionId = echoed;

    // Server forgot us — drop the id so the next call re-initializes.
    if (res.status === 404 && this.sessionId) {
      this.sessionId = null;
      clearTimeout(timeout);
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `MCP HTTP session expired (${this.spec.name}); will re-initialize`, {
          context: { status: 404 }
        })
      );
    }

    // Notifications: 202 Accepted with no body.
    if (expectId === null && res.status === 202) {
      clearTimeout(timeout);
      return ok(undefined);
    }

    if (!res.ok) {
      clearTimeout(timeout);
      const text = await safeText(res);
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `MCP HTTP ${res.status} for ${msg.method}: ${text.slice(0, 200)}`, {
          context: { status: res.status }
        })
      );
    }

    const ct = res.headers.get('content-type') ?? '';
    try {
      if (ct.includes('text/event-stream')) {
        const result = await readSseUntilResponse(res, expectId, log);
        clearTimeout(timeout);
        return result;
      }
      // Plain JSON response.
      const body = (await res.json()) as JsonRpcMessage | readonly JsonRpcMessage[];
      clearTimeout(timeout);
      return extractResponse(body, expectId);
    } catch (e) {
      clearTimeout(timeout);
      return err(
        atlasError('PROVIDER_INVALID_RESPONSE', `MCP HTTP body parse failed: ${(e as Error).message}`, {
          cause: e
        })
      );
    }
  }
}

const safeText = async (res: Response): Promise<string> => {
  try {
    return await res.text();
  } catch {
    return '';
  }
};

const extractResponse = (
  body: JsonRpcMessage | readonly JsonRpcMessage[],
  expectId: number | string | null
): Result<unknown, AtlasError> => {
  const msgs = Array.isArray(body) ? body : [body];
  if (expectId === null) return ok(undefined);
  for (const m of msgs) {
    if (m.id === expectId) {
      if (m.error) {
        return err(
          atlasError('TOOL_EXECUTION_FAILED', `mcp error: ${m.error.message}`, {
            context: { code: m.error.code }
          })
        );
      }
      return ok(m.result);
    }
  }
  return err(atlasError('PROVIDER_INVALID_RESPONSE', `no JSON-RPC response for id ${String(expectId)}`));
};

/**
 * Drain an SSE stream until we find the JSON-RPC response with the
 * expected id. Server-pushed notifications/requests on the same stream
 * are logged and ignored.
 */
const readSseUntilResponse = async (
  res: Response,
  expectId: number | string | null,
  logger: typeof log
): Promise<Result<unknown, AtlasError>> => {
  if (!res.body) {
    return err(atlasError('PROVIDER_INVALID_RESPONSE', 'MCP HTTP SSE response has no body'));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  // SSE event boundary is a blank line. Each event has zero or more
  // `field: value` lines. We only care about `data:` payloads which
  // (per the MCP spec) carry one JSON-RPC message each.
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIdx: number;
    while ((sepIdx = nextEventBoundary(buffer)) >= 0) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx).replace(/^(\r?\n)+/, '');
      const dataLines: string[] = [];
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      const payload = dataLines.join('\n');
      let parsed: JsonRpcMessage | readonly JsonRpcMessage[];
      try {
        parsed = JSON.parse(payload) as JsonRpcMessage | readonly JsonRpcMessage[];
      } catch (e) {
        logger.warn({ payload, err: e }, 'mcp http: bad SSE JSON');
        continue;
      }
      const msgs = Array.isArray(parsed) ? parsed : [parsed];
      for (const m of msgs) {
        if (m.id === expectId) {
          // Don't bother draining the rest of the stream — the server
          // is supposed to close after the response anyway.
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          if (m.error) {
            return err(
              atlasError('TOOL_EXECUTION_FAILED', `mcp error: ${m.error.message}`, {
                context: { code: m.error.code }
              })
            );
          }
          return ok(m.result);
        }
        // Server-initiated request/notification — not supported yet.
        if (m.method) {
          logger.debug({ method: m.method }, 'mcp http: ignoring server-initiated message');
        }
      }
    }
  }
  return err(atlasError('PROVIDER_INVALID_RESPONSE', `MCP SSE stream ended without response for id ${String(expectId)}`));
};

const nextEventBoundary = (s: string): number => {
  const a = s.indexOf('\n\n');
  const b = s.indexOf('\r\n\r\n');
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
};
