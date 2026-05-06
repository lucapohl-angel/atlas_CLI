/**
 * Agent execution loop.
 *
 * Runs a streaming completion, intercepts every tool_call the model
 * emits, executes it via the registry, appends the result to the
 * conversation, and re-streams — until the model returns without
 * requesting any more tools (or hits a hard limit / cancellation).
 *
 * The loop is provider-agnostic; it only depends on `Provider.stream`
 * yielding the unified `StreamEvent` union.
 *
 * Output is itself an async iterable of `LoopEvent`s so a TUI / REPL
 * can render incrementally without buffering whole turns.
 */
import { atlasError, type AtlasError } from '../errors.js';
import { runHooks, type HookRegistry } from '../hooks/index.js';
import { childLogger } from '../logger.js';
import {
  invokeTool,
  type ToolContext,
  type ToolRegistry
} from '../tools/index.js';
import type {
  CompletionRequest,
  Message,
  Provider,
  ReasoningOptions,
  ToolCall,
  TokenUsage
} from '../providers/types.js';
import { registryToSpecs, toolToSpec } from '../providers/tool-spec.js';
import { truncateForLLM } from '../tools/truncate.js';

const log = childLogger('loop');

export interface AgentLoopOptions {
  readonly provider: Provider;
  readonly model: string;
  readonly fallbackModels?: readonly string[];
  readonly tools: ToolRegistry;
  readonly toolContext: ToolContext;
  readonly initialMessages: readonly Message[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly reasoning?: ReasoningOptions;
  /** Hard cap on tool-use rounds. Defaults to 24. */
  readonly maxRounds?: number;
  /**
   * Optional hook registry. When provided, the loop fires `beforeTool`
   * (which can block or rewrite the input), `afterTool`, and
   * `afterMessage` for the assistant turn.
   */
  readonly hooks?: HookRegistry;
  readonly signal?: AbortSignal;
}

export type LoopEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'tool_call_start'; readonly call: ToolCall }
  | {
      readonly type: 'tool_call_done';
      readonly call: ToolCall;
      readonly outcome:
        | { readonly type: 'ok'; readonly summary: string }
        | { readonly type: 'error'; readonly error: AtlasError };
    }
  | { readonly type: 'turn_end'; readonly assistantMessage: Message }
  | {
      readonly type: 'done';
      readonly finishReason: string | null;
      readonly usage?: TokenUsage;
      readonly rounds: number;
      readonly messages: readonly Message[];
    }
  | { readonly type: 'error'; readonly error: AtlasError };

const DEFAULT_MAX_ROUNDS = 24;

export const runAgentLoop = async function* (
  opts: AgentLoopOptions
): AsyncGenerator<LoopEvent> {
  const messages: Message[] = [...opts.initialMessages];
  const supportsToolCalling = opts.provider.supportsToolCalling !== false;
  const allowedToolNameSet = supportsToolCalling
    ? opts.provider.allowedToolNames
      ? new Set(opts.provider.allowedToolNames)
      : null
    : new Set<string>();
  const tools = supportsToolCalling
    ? allowedToolNameSet
      ? opts.tools.list().filter((tool) => allowedToolNameSet.has(tool.name)).map(toolToSpec)
      : registryToSpecs(opts.tools)
    : [];
  log.debug(
    {
      provider: opts.provider.name,
      supportsToolCalling,
      toolCount: tools.length,
      allowedToolNames: opts.provider.allowedToolNames ?? null
    },
    'agent loop prepared tool specs'
  );
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  let rounds = 0;
  let lastFinish: string | null = null;
  let lastUsage: TokenUsage | undefined;

  while (rounds < maxRounds) {
    if (opts.signal?.aborted) {
      yield { type: 'error', error: atlasError('CANCELLED', 'agent loop cancelled') };
      return;
    }
    rounds += 1;

    const request: CompletionRequest = {
      model: opts.model,
      messages,
      ...(opts.fallbackModels ? { fallbackModels: opts.fallbackModels } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      ...(opts.signal ? { signal: opts.signal } : {})
    };
    log.debug(
      {
        provider: opts.provider.name,
        model: opts.model,
        round: rounds,
        messages: messages.length,
        tools: tools.length
      },
      'agent loop starting provider stream'
    );

    let assistantText = '';
    const turnToolCalls: ToolCall[] = [];

    for await (const ev of opts.provider.stream(request)) {
      if (opts.signal?.aborted) {
        yield { type: 'error', error: atlasError('CANCELLED', 'agent loop cancelled') };
        return;
      }
      switch (ev.type) {
        case 'delta':
          assistantText += ev.text;
          yield { type: 'delta', text: ev.text };
          break;
        case 'thinking':
          yield { type: 'thinking', text: ev.text };
          break;
        case 'tool_call_delta':
          // Surface partial tool-call assembly to the UI via no-op for now.
          // (Full call is processed on the assembled `tool_call` event.)
          break;
        case 'tool_call':
          turnToolCalls.push(ev.call);
          break;
        case 'done':
          lastFinish = ev.finishReason;
          if (ev.usage) lastUsage = ev.usage;
          break;
        case 'error':
          yield { type: 'error', error: ev.error };
          return;
      }
    }

    const assistantMessage: Message = {
      role: 'assistant',
      content: assistantText,
      ...(turnToolCalls.length > 0 ? { toolCalls: turnToolCalls } : {})
    };
    messages.push(assistantMessage);
    yield { type: 'turn_end', assistantMessage };

    if (opts.hooks) {
      // Best-effort observation point: hooks can't (yet) rewrite the
      // assistant message — they'd need to retract a stream that's
      // already been emitted. Block here is a no-op for the same reason.
      await runHooks(opts.hooks, 'afterMessage', {
        event: 'afterMessage',
        role: 'assistant',
        content: assistantText,
        ...(opts.signal ? { signal: opts.signal } : {})
      });
    }

    if (turnToolCalls.length === 0) {
      yield {
        type: 'done',
        finishReason: lastFinish,
        ...(lastUsage ? { usage: lastUsage } : {}),
        rounds,
        messages
      };
      return;
    }

    // Execute every tool call in order, append a `tool` message per call.
    for (const call of turnToolCalls) {
      yield { type: 'tool_call_start', call };
      if (allowedToolNameSet && !allowedToolNameSet.has(call.name)) {
        const error = atlasError('TOOL_DENIED_BY_USER', `tool ${call.name} is not enabled for this provider`, {
          context: { name: call.name, provider: opts.provider.name }
        });
        messages.push({
          role: 'tool',
          content: `error: ${error.message}`,
          toolCallId: call.id,
          name: call.name
        });
        yield { type: 'tool_call_done', call, outcome: { type: 'error', error } };
        continue;
      }
      let parsed: unknown;
      try {
        parsed = call.arguments.length > 0 ? JSON.parse(call.arguments) : {};
      } catch (e) {
        const error = atlasError(
          'TOOL_INPUT_INVALID',
          `tool ${call.name} arguments are not valid JSON`,
          { context: { name: call.name, raw: call.arguments }, cause: e }
        );
        log.warn({ err: error }, 'tool args parse failure');
        const summary = `error: ${error.message}`;
        messages.push({
          role: 'tool',
          content: summary,
          toolCallId: call.id,
          name: call.name
        });
        yield { type: 'tool_call_done', call, outcome: { type: 'error', error } };
        continue;
      }

      let toolInput: unknown = parsed;
      if (opts.hooks) {
        // Find the most recent user-role message so beforeTool hooks
        // can react to vague / contradictory user input without
        // re-walking the history themselves.
        let lastUserMessage: string | undefined;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const m = messages[i];
          if (m && m.role === 'user' && typeof m.content === 'string') {
            lastUserMessage = m.content;
            break;
          }
        }
        const decision = await runHooks(opts.hooks, 'beforeTool', {
          event: 'beforeTool',
          tool: call.name,
          input: toolInput,
          ...(lastUserMessage !== undefined ? { lastUserMessage } : {}),
          ...(opts.signal ? { signal: opts.signal } : {})
        });
        if (decision.action === 'block') {
          const error = atlasError('TOOL_DENIED_BY_USER', `hook blocked ${call.name}: ${decision.reason}`, {
            context: { name: call.name, reason: decision.reason }
          });
          messages.push({
            role: 'tool',
            content: `error: ${error.message}`,
            toolCallId: call.id,
            name: call.name
          });
          yield { type: 'tool_call_done', call, outcome: { type: 'error', error } };
          continue;
        }
        if (decision.action === 'modify') toolInput = decision.payload;
      }

      const result = await invokeTool(opts.tools, call.name, toolInput, opts.toolContext);

      // Run afterTool hooks first so guardrails (e.g. secret redaction,
      // prompt-injection warnings) can rewrite the summary before it
      // lands in the conversation history.
      let finalResult = result;
      if (opts.hooks) {
        const decision = await runHooks(opts.hooks, 'afterTool', {
          event: 'afterTool',
          tool: call.name,
          input: toolInput,
          result: result.ok
            ? result.value
            : { type: 'error', message: result.error.message },
          ...(opts.signal ? { signal: opts.signal } : {})
        });
        if (
          decision.action === 'modify' &&
          result.ok &&
          decision.payload &&
          typeof decision.payload === 'object' &&
          'summary' in (decision.payload as Record<string, unknown>) &&
          typeof (decision.payload as { summary: unknown }).summary === 'string'
        ) {
          finalResult = {
            ok: true,
            value: decision.payload as typeof result.value
          };
        }
      }

      if (finalResult.ok) {
        // Hard safety cap: even if a tool forgot to truncate, never let
        // a single tool result exceed ~32K chars (~8K tokens) in the
        // conversation history. Per-tool truncation should already keep
        // most outputs well under this.
        const safeSummary = truncateForLLM(finalResult.value.summary, {
          maxChars: 32_000
        });
        messages.push({
          role: 'tool',
          content: safeSummary,
          toolCallId: call.id,
          name: call.name
        });
        yield {
          type: 'tool_call_done',
          call,
          outcome: { type: 'ok', summary: safeSummary }
        };
      } else {
        const summary = `error: ${finalResult.error.message}`;
        messages.push({
          role: 'tool',
          content: summary,
          toolCallId: call.id,
          name: call.name
        });
        yield {
          type: 'tool_call_done',
          call,
          outcome: { type: 'error', error: finalResult.error }
        };
      }
    }
  }

  yield {
    type: 'error',
    error: atlasError(
      'INTERNAL',
      `agent loop exceeded max rounds (${maxRounds})`,
      { context: { maxRounds } }
    )
  };
};
