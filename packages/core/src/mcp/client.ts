/**
 * MCP (Model Context Protocol) client.
 *
 * Implements the JSON-RPC verbs Atlas needs:
 *   - initialize
 *   - tools/list
 *   - tools/call
 *   - notifications/initialized
 *
 * Transport-agnostic: pass a `StdioTransportSpec` to talk to a local
 * subprocess, or an `HttpTransportSpec` to talk to a hosted Streamable
 * HTTP endpoint (Higgsfield, Figma, etc).
 */
import { z } from 'zod';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import { HttpTransport, type HttpTransportSpec } from './transports/http.js';
import { StdioTransport, type StdioTransportSpec } from './transports/stdio.js';
import type { McpTransport } from './transports/types.js';

export type McpServerSpec =
  | (StdioTransportSpec & { readonly transport?: 'stdio' })
  | (HttpTransportSpec & { readonly transport: 'http' });

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

const isHttpSpec = (spec: McpServerSpec): spec is HttpTransportSpec & { transport: 'http' } =>
  spec.transport === 'http';

const buildTransport = (spec: McpServerSpec): McpTransport =>
  isHttpSpec(spec) ? new HttpTransport(spec) : new StdioTransport(spec as StdioTransportSpec);

export class McpClient {
  private readonly transport: McpTransport;

  constructor(public readonly spec: McpServerSpec) {
    this.transport = buildTransport(spec);
  }

  async start(signal?: AbortSignal): Promise<Result<void, AtlasError>> {
    const open = await this.transport.start(signal);
    if (!open.ok) return err(open.error);
    const initRes = await this.transport.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'atlas-cli', version: '0.1.0' }
    });
    if (!initRes.ok) return err(initRes.error);
    // Per spec, send `notifications/initialized` after init.
    await this.transport.notify('notifications/initialized', {});
    return ok(undefined);
  }

  async listTools(): Promise<Result<readonly McpToolDescriptor[], AtlasError>> {
    const r = await this.transport.request('tools/list', {});
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
    const r = await this.transport.request('tools/call', { name, arguments: args });
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
    this.transport.stop();
  }
}

export type { HttpTransportSpec, StdioTransportSpec };
