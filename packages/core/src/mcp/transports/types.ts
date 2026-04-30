/**
 * Transport contract for MCP. The original stdio-only `McpClient`
 * inlined the spawn/parse logic; we extract it here so HTTP (and any
 * future transport) can plug in without touching the higher-level
 * client.
 */
import type { AtlasError } from '../../errors.js';
import type { Result } from '../../result.js';

export interface JsonRpcMessage {
  readonly jsonrpc: '2.0';
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export interface McpTransport {
  /** Open the underlying connection. Idempotent. */
  start(signal?: AbortSignal): Promise<Result<void, AtlasError>>;
  /** Round-trip a JSON-RPC request and resolve with the server's response. */
  request(method: string, params: unknown): Promise<Result<unknown, AtlasError>>;
  /** Fire-and-forget JSON-RPC notification. Never resolves a response. */
  notify(method: string, params: unknown): Promise<Result<void, AtlasError>>;
  /** Tear down. Idempotent. */
  stop(): void;
}
