/**
 * AI-assisted "add a custom MCP server" harness.
 *
 * The user types something like "add the linear mcp server" and we
 * spin up a tightly-scoped agent loop with exactly two tools:
 *
 *   - web_fetch(url)        — fetch a public HTTPS URL (16KB body cap)
 *   - add_mcp_server(spec)  — write a single new entry into
 *                              ~/.atlas/config.yaml
 *
 * The system prompt forbids anything else (no shell, no file writes
 * beyond the one config call, no other research topics). The loop is
 * capped at 8 rounds. Once `add_mcp_server` returns ok, the model is
 * instructed to stop — and the harness yields a terminal `added`
 * event so the TUI can advance to the restart-required overlay.
 *
 * This is intentionally a separate, hard-coded ToolRegistry: we never
 * register these tools with the main agent registry.
 */
import { z } from 'zod';
import {
  ToolRegistry,
  allowAllPolicy,
  atlasError,
  err,
  ok,
  runAgentLoop,
  saveConfig,
  type AtlasConfig,
  type Provider,
  type Tool
} from '@atlas/core';

export interface AiAddMcpOptions {
  readonly provider: Provider;
  readonly model: string;
  readonly userPrompt: string;
  readonly currentConfig: AtlasConfig;
  readonly signal?: AbortSignal;
}

export type AiAddMcpEvent =
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_ok'; readonly name: string; readonly summary: string }
  | { readonly type: 'tool_error'; readonly name: string; readonly message: string }
  | {
      readonly type: 'added';
      readonly serverName: string;
      readonly configPath: string;
    }
  | { readonly type: 'done'; readonly addedServer?: string }
  | { readonly type: 'error'; readonly message: string };

const SYSTEM_PROMPT = `You are a single-purpose helper running inside the Atlas CLI.

Your ONLY job is to add ONE Model Context Protocol (MCP) server entry
to the user's ~/.atlas/config.yaml. You have exactly two tools:

  - web_fetch(url): fetch a public HTTPS page (e.g. an MCP server's
    GitHub README, npm page, or docs site). Use this to look up the
    correct command/args/env or HTTP URL/headers for the server the
    user asked for.
  - add_mcp_server(spec): write the entry. Call this AT MOST ONCE.

HARD RULES:
  1. Do NOT attempt anything other than adding the requested MCP
     server. If the user asks anything else (run code, edit files,
     search the web for unrelated topics, generate prose, etc.) reply
     with one sentence refusing and stop.
  2. Do NOT browse beyond what is needed for this single MCP entry.
     Two or three web_fetch calls is plenty; if a search engine page
     is needed, fetch a single GitHub or official-docs URL directly.
  3. Prefer published MCP servers from the modelcontextprotocol
     organization (https://github.com/modelcontextprotocol/servers)
     or first-party vendor servers. If you cannot identify a real
     server, say so and stop instead of guessing.
  4. For stdio transport prefer 'npx -y <package>' style commands
     when an npm package exists; otherwise use the upstream binary
     name.
  5. Do NOT include real secrets in the env field. If the server
     needs an API key, set the env value to the empty string and
     explain in your reply text that the user needs to fill it in
     before restarting.
  6. After add_mcp_server returns ok, write ONE short confirmation
     sentence and STOP. Do not call any more tools.`;

const AddMcpInput = z
  .object({
    name: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9-]*$/u, 'lowercase letters, digits, dashes only'),
    transport: z.enum(['stdio', 'http']),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string()).optional(),
    notes: z.string().optional()
  })
  .superRefine((data: { transport: 'stdio' | 'http'; command?: string; url?: string }, ctx: z.RefinementCtx) => {
    if (data.transport === 'stdio' && !data.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'stdio transport requires `command`',
        path: ['command']
      });
    }
    if (data.transport === 'http' && !data.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'http transport requires `url`',
        path: ['url']
      });
    }
  });

const WebFetchInput = z.object({
  url: z
    .string()
    .url()
    .refine((u: string) => u.startsWith('https://'), { message: 'must be https://' })
});

const MAX_BODY_BYTES = 16_000;

export const runAiAddMcp = async function* (
  opts: AiAddMcpOptions
): AsyncGenerator<AiAddMcpEvent> {
  let configRef: AtlasConfig = opts.currentConfig;
  let addedServer: string | undefined;
  let addedConfigPath = '~/.atlas/config.yaml';

  const tools = new ToolRegistry();

  const webFetchTool: Tool<z.infer<typeof WebFetchInput>> = {
    name: 'web_fetch',
    description:
      'Fetch a public HTTPS URL and return up to 16KB of its body. ' +
      'Use this only to research how to install/configure a Model ' +
      'Context Protocol (MCP) server for the user. One URL per call.',
    approval: 'auto',
    schema: WebFetchInput,
    execute: async (input, ctx) => {
      try {
        const fetchOpts: RequestInit = { redirect: 'follow' };
        if (ctx.signal) fetchOpts.signal = ctx.signal;
        const res = await fetch(input.url, fetchOpts);
        if (!res.ok) {
          return err(
            atlasError(
              'TOOL_EXECUTION_FAILED',
              `web_fetch failed: ${res.status} ${res.statusText} for ${input.url}`
            )
          );
        }
        const buf = await res.text();
        const body = buf.length > MAX_BODY_BYTES ? buf.slice(0, MAX_BODY_BYTES) + '\n…[truncated]' : buf;
        return ok({ type: 'ok' as const, summary: `[${res.status}] ${input.url}\n\n${body}` });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(atlasError('TOOL_EXECUTION_FAILED', `web_fetch error: ${msg}`));
      }
    }
  };
  tools.register(webFetchTool);

  const addServerTool: Tool<z.infer<typeof AddMcpInput>> = {
    name: 'add_mcp_server',
    description:
      'Add ONE Model Context Protocol server entry to ~/.atlas/config.yaml. ' +
      'Call this at most once. After it returns ok, stop \u2014 do not call ' +
      'more tools. For stdio transport set command/args (env optional). ' +
      'For http transport set url (headers optional). Do not include real ' +
      'secret values in env; use empty strings and tell the user in your ' +
      'reply.',
    approval: 'auto',
    schema: AddMcpInput,
    execute: async (input) => {
      if (addedServer !== undefined) {
        return err(
          atlasError(
            'TOOL_EXECUTION_FAILED',
            'add_mcp_server may only be called once per session'
          )
        );
      }
      if (configRef.mcp.servers.some((s) => s.name === input.name)) {
        return err(
          atlasError(
            'TOOL_EXECUTION_FAILED',
            `MCP server '${input.name}' already configured \u2014 pick a different name or remove the existing one`
          )
        );
      }
      const next: AtlasConfig = {
        ...configRef,
        mcp: {
          ...configRef.mcp,
          servers: [
            ...configRef.mcp.servers,
            {
              name: input.name,
              transport: input.transport,
              ...(input.command !== undefined ? { command: input.command } : {}),
              args: input.args ?? [],
              env: input.env ?? {},
              ...(input.url !== undefined ? { url: input.url } : {}),
              headers: input.headers ?? {},
              enabled: true
            }
          ]
        }
      };
      const saved = await saveConfig(next);
      if (!saved.ok) return err(saved.error);
      configRef = next;
      addedServer = input.name;
      addedConfigPath = saved.value.path;
      return ok({
        type: 'ok' as const,
        summary: `Added MCP server '${input.name}' (${input.transport}) to ${saved.value.path}.`
      });
    }
  };
  tools.register(addServerTool);

  const gen = runAgentLoop({
    provider: opts.provider,
    model: opts.model,
    tools,
    toolContext: { cwd: process.cwd(), approve: allowAllPolicy, ...(opts.signal ? { signal: opts.signal } : {}) },
    initialMessages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: opts.userPrompt }
    ],
    maxRounds: 8,
    ...(opts.signal ? { signal: opts.signal } : {})
  });

  for await (const ev of gen) {
    switch (ev.type) {
      case 'delta':
        yield { type: 'text', text: ev.text };
        break;
      case 'thinking':
        yield { type: 'thinking', text: ev.text };
        break;
      case 'tool_call_start':
        yield { type: 'tool_call', name: ev.call.name, input: ev.call.arguments };
        break;
      case 'tool_call_done':
        if (ev.outcome.type === 'ok') {
          yield {
            type: 'tool_ok',
            name: ev.call.name,
            summary: ev.outcome.summary.slice(0, 240)
          };
          if (ev.call.name === 'add_mcp_server' && addedServer !== undefined) {
            yield { type: 'added', serverName: addedServer, configPath: addedConfigPath };
          }
        } else {
          yield { type: 'tool_error', name: ev.call.name, message: ev.outcome.error.message };
        }
        break;
      case 'done':
        yield { type: 'done', ...(addedServer !== undefined ? { addedServer } : {}) };
        return;
      case 'error':
        yield { type: 'error', message: ev.error.message };
        return;
      default:
        break;
    }
  }
};
