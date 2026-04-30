/**
 * Stdio transport for MCP — line-framed JSON-RPC over a child process'
 * stdin/stdout (the original transport, extracted from McpClient).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { atlasError, type AtlasError } from '../../errors.js';
import { childLogger } from '../../logger.js';
import { err, ok, type Result } from '../../result.js';
import type { JsonRpcMessage, McpTransport } from './types.js';

const log = childLogger('mcp.stdio');

export interface StdioTransportSpec {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class StdioTransport implements McpTransport {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<
    number | string,
    { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly spec: StdioTransportSpec) {}

  async start(signal?: AbortSignal): Promise<Result<void, AtlasError>> {
    if (this.child) return ok(undefined);
    try {
      this.child = spawn(this.spec.command, [...(this.spec.args ?? [])], {
        env: { ...process.env, ...this.spec.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `failed to spawn MCP server ${this.spec.name}`, {
          cause: e
        })
      );
    }

    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr!.on('data', (chunk: Buffer) => {
      log.debug({ server: this.spec.name, stderr: chunk.toString('utf8') }, 'mcp stderr');
    });
    this.child.on('exit', (code) => {
      log.info({ server: this.spec.name, code }, 'mcp server exited');
      for (const p of this.pending.values()) p.reject(new Error('mcp server exited'));
      this.pending.clear();
      this.child = null;
    });
    signal?.addEventListener('abort', () => this.stop(), { once: true });
    return ok(undefined);
  }

  async request(method: string, params: unknown): Promise<Result<unknown, AtlasError>> {
    const id = this.nextId++;
    const promise = new Promise<JsonRpcMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      this.send({ jsonrpc: '2.0', id, method, params });
    } catch (e) {
      this.pending.delete(id);
      return err(atlasError('TOOL_EXECUTION_FAILED', `mcp send failed: ${(e as Error).message}`));
    }

    const timeout = new Promise<JsonRpcMessage>((_, reject) =>
      setTimeout(() => reject(new Error('mcp request timeout')), REQUEST_TIMEOUT_MS)
    );

    let response: JsonRpcMessage;
    try {
      response = await Promise.race([promise, timeout]);
    } catch (e) {
      this.pending.delete(id);
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `mcp request failed: ${(e as Error).message}`)
      );
    }

    if (response.error) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `mcp error: ${response.error.message}`, {
          context: { code: response.error.code }
        })
      );
    }
    return ok(response.result);
  }

  async notify(method: string, params: unknown): Promise<Result<void, AtlasError>> {
    try {
      this.send({ jsonrpc: '2.0', method, params });
      return ok(undefined);
    } catch (e) {
      return err(atlasError('TOOL_EXECUTION_FAILED', `mcp notify failed: ${(e as Error).message}`));
    }
  }

  stop(): void {
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.child = null;
    }
  }

  private send(msg: JsonRpcMessage): void {
    if (!this.child?.stdin) throw new Error('mcp child not started');
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch (e) {
        log.warn({ line, err: e }, 'mcp: failed to parse line');
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  }
}
