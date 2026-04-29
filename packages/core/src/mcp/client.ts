/**
 * Minimal MCP (Model Context Protocol) client — stdio transport only.
 *
 * Implements just enough of the JSON-RPC framing to:
 *   - initialize a server
 *   - list its tools
 *   - call a tool
 *
 * HTTP transport is a Phase 12 polish item.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import { err, ok, type Result } from '../result.js';

const log = childLogger('mcp');

export interface McpServerSpec {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

const ToolListResult = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.unknown().optional()
    })
  )
});

const ToolCallResult = z.object({
  content: z
    .array(
      z.union([
        z.object({ type: z.literal('text'), text: z.string() }),
        z.object({ type: z.string(), text: z.string().optional() }).passthrough()
      ])
    )
    .default([]),
  isError: z.boolean().optional()
});

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<
    number | string,
    { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly spec: McpServerSpec) {}

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

    const initRes = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'atlas-cli', version: '0.1.0' }
    });
    if (!initRes.ok) return err(initRes.error);
    // Per spec, send `notifications/initialized` after init.
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    return ok(undefined);
  }

  async listTools(): Promise<Result<readonly McpToolDescriptor[], AtlasError>> {
    const r = await this.request('tools/list', {});
    if (!r.ok) return err(r.error);
    const parsed = ToolListResult.safeParse(r.value);
    if (!parsed.success) {
      return err(
        atlasError('PROVIDER_INVALID_RESPONSE', 'invalid tools/list response', {
          context: { issues: parsed.error.issues }
        })
      );
    }
    return ok(parsed.data.tools);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<Result<{ readonly text: string; readonly isError: boolean }, AtlasError>> {
    const r = await this.request('tools/call', { name, arguments: args });
    if (!r.ok) return err(r.error);
    const parsed = ToolCallResult.safeParse(r.value);
    if (!parsed.success) {
      return err(
        atlasError('PROVIDER_INVALID_RESPONSE', 'invalid tools/call response', {
          context: { issues: parsed.error.issues }
        })
      );
    }
    const text = parsed.data.content
      .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
      .join('');
    return ok({ text, isError: parsed.data.isError ?? false });
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

  private async request(
    method: string,
    params: unknown
  ): Promise<Result<unknown, AtlasError>> {
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
      setTimeout(() => reject(new Error('mcp request timeout')), 30_000)
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
