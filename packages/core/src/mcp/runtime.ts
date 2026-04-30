/**
 * MCP runtime helpers — spawn configured servers and adapt every tool
 * they advertise into the local `Tool<unknown>` contract so the agent
 * loop can call them transparently alongside built-in tools.
 *
 * Tool naming convention: `mcp__<server>__<tool>`. The double-underscore
 * delimiter avoids collisions with built-in tools (which use snake_case
 * single words) and stays inside provider name-validation limits.
 */
import { z } from 'zod';
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import { err, ok, type Result } from '../result.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Tool, ToolContext, ToolOk } from '../tools/types.js';
import { McpClient, type McpServerSpec, type McpToolDescriptor } from './client.js';

const log = childLogger('mcp.runtime');

export interface RunningMcpServer {
  readonly spec: McpServerSpec;
  readonly client: McpClient;
  readonly tools: readonly McpToolDescriptor[];
}

export interface FailedMcpServer {
  readonly spec: McpServerSpec;
  readonly error: AtlasError;
}

export interface McpStartupResult {
  readonly running: readonly RunningMcpServer[];
  readonly failed: readonly FailedMcpServer[];
  /** Stop every successfully-started server. Idempotent. */
  stopAll(): void;
}

const TOOL_NAME_PREFIX = 'mcp__';

export const mcpToolName = (server: string, tool: string): string =>
  `${TOOL_NAME_PREFIX}${sanitize(server)}__${sanitize(tool)}`;

const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * Wrap one MCP tool descriptor as an Atlas Tool. The schema is permissive
 * (`record(string, unknown)`) because translating arbitrary JSON Schema
 * to Zod isn't worth the complexity for a stdio bridge — the MCP server
 * will validate the payload itself and surface errors via `isError`.
 */
export const adaptMcpTool = (
  client: McpClient,
  server: string,
  desc: McpToolDescriptor
): Tool<Record<string, unknown>> => {
  const fullName = mcpToolName(server, desc.name);
  return {
    name: fullName,
    description: desc.description ?? `MCP tool ${desc.name} from ${server}`,
    approval: 'auto',
    schema: z.record(z.string(), z.unknown()),
    execute: async (
      input: Record<string, unknown>,
      _ctx: ToolContext
    ): Promise<Result<ToolOk, AtlasError>> => {
      const r = await client.callTool(desc.name, input);
      if (!r.ok) return err(r.error);
      if (r.value.isError) {
        return err(
          atlasError('TOOL_EXECUTION_FAILED', `MCP tool ${fullName} failed`, {
            context: { text: r.value.text }
          })
        );
      }
      const summary = r.value.text.slice(0, 4000);
      return ok({ type: 'ok', summary });
    }
  };
};

/**
 * Start every spec, list their tools. Failures are reported but never
 * throw — the TUI keeps booting even if one MCP server is misconfigured.
 */
export const startMcpServers = async (
  specs: readonly McpServerSpec[],
  signal?: AbortSignal
): Promise<McpStartupResult> => {
  const running: RunningMcpServer[] = [];
  const failed: FailedMcpServer[] = [];

  await Promise.all(
    specs.map(async (spec) => {
      const client = new McpClient(spec);
      const startRes = await client.start(signal);
      if (!startRes.ok) {
        failed.push({ spec, error: startRes.error });
        log.warn({ server: spec.name, err: startRes.error.message }, 'mcp start failed');
        return;
      }
      const listRes = await client.listTools();
      if (!listRes.ok) {
        client.stop();
        failed.push({ spec, error: listRes.error });
        log.warn({ server: spec.name, err: listRes.error.message }, 'mcp tools/list failed');
        return;
      }
      running.push({ spec, client, tools: listRes.value });
      log.info({ server: spec.name, tools: listRes.value.length }, 'mcp server started');
    })
  );

  return {
    running,
    failed,
    stopAll: (): void => {
      for (const r of running) r.client.stop();
    }
  };
};

/**
 * Register every tool from every running MCP server into a tool registry.
 * Returns the same registry for chaining. Skips servers whose tools
 * collide with already-registered names (built-ins always win).
 */
export const registerMcpTools = (
  registry: ToolRegistry,
  running: readonly RunningMcpServer[]
): ToolRegistry => {
  for (const server of running) {
    for (const desc of server.tools) {
      const tool = adaptMcpTool(server.client, server.spec.name, desc);
      try {
        registry.register(tool);
      } catch (e) {
        log.warn(
          { server: server.spec.name, tool: tool.name, err: (e as Error).message },
          'skipping MCP tool — name collision'
        );
      }
    }
  }
  return registry;
};
