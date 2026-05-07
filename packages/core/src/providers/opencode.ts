/**
 * OpenCode Zen / Go provider support.
 *
 * OpenCode exposes model families through a few provider-compatible
 * endpoints. Atlas keeps one provider factory and picks the correct
 * route per model id so catalog entries and runtime calls agree.
 */
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import type {
  CompletionRequest,
  Message,
  Provider,
  StreamEvent,
  TokenUsage
} from './types.js';

const log = childLogger('provider:opencode');

export type OpenCodePlan = 'zen' | 'go';
export type OpenCodeRoute = 'responses' | 'messages' | 'chat-completions';

export interface OpenCodeProviderOptions {
  readonly plan: OpenCodePlan;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

interface OpenAIStreamToolCallDelta {
  readonly index?: number;
  readonly id?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

interface OpenAIStreamChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: {
      readonly content?: string | null;
      readonly reasoning?: string | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: ReadonlyArray<OpenAIStreamToolCallDelta>;
    };
    readonly finish_reason?: string | null;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
    readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  };
}

interface ResponsesInputItem {
  readonly type: 'message' | 'function_call' | 'function_call_output';
  readonly role?: 'user' | 'assistant' | 'system';
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
  readonly output?: string;
}

interface AnthropicTextBlock {
  readonly type: 'text';
  readonly text: string;
}
interface AnthropicToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}
interface AnthropicToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;
interface AnthropicMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly AnthropicContentBlock[];
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
  emitted: boolean;
}

const SSE_DATA_PREFIX = 'data:';
const SSE_EVENT_PREFIX = 'event:';
const SSE_DONE = '[DONE]';

export const stripOpenCodeAtlasPrefix = (modelId: string): string => {
  if (modelId.startsWith('opencode-go/')) return modelId.slice('opencode-go/'.length);
  if (modelId.startsWith('opencode/')) return modelId.slice('opencode/'.length);
  return modelId;
};

export const openCodeRouteForModel = (
  plan: OpenCodePlan,
  atlasModelId: string
): OpenCodeRoute | null => {
  const id = stripOpenCodeAtlasPrefix(atlasModelId).toLowerCase();
  if (/^(gemini|google[\/-])/.test(id)) return null;

  if (plan === 'zen') {
    if (/^(gpt-|o[1-9]|codex-)/.test(id) || /codex/.test(id)) return 'responses';
    if (/^claude-/.test(id)) return 'messages';
    if (/^(qwen|minimax|glm|kimi|big-pickle|ling|hy3|nemotron)/.test(id)) {
      return 'chat-completions';
    }
    return null;
  }

  if (/^minimax-m2\.[57]/.test(id)) return 'messages';
  if (/^(glm|kimi|deepseek|mimo|qwen)/.test(id)) return 'chat-completions';
  return null;
};

export const createOpenCodeProvider = (options: OpenCodeProviderOptions): Provider => {
  const baseUrl = (
    options.baseUrl ??
    (options.plan === 'zen' ? 'https://opencode.ai/zen/v1' : 'https://opencode.ai/zen/go/v1')
  ).replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;
  const providerName = options.plan === 'zen' ? 'opencode-zen' : 'opencode-go';

  return {
    name: providerName,
    async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
      const model = stripOpenCodeAtlasPrefix(request.model);
      const route = openCodeRouteForModel(options.plan, request.model);
      if (!route) {
        yield {
          type: 'error',
          error: atlasError(
            'CONFIG_INVALID',
            `OpenCode ${options.plan} cannot route model ${request.model}`,
            { context: { model: request.model, plan: options.plan } }
          )
        };
        return;
      }

      const url = `${baseUrl}/${route === 'chat-completions' ? 'chat/completions' : route}`;
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream'
      };
      if (route === 'messages') headers['anthropic-version'] = '2023-06-01';

      const body = JSON.stringify(buildBody(route, model, request));
      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers,
          body,
          ...(request.signal ? { signal: request.signal } : {})
        });
      } catch (e) {
        if (request.signal?.aborted) {
          yield { type: 'error', error: atlasError('CANCELLED', 'request cancelled') };
          return;
        }
        yield {
          type: 'error',
          error: atlasError('PROVIDER_NETWORK', `network error contacting ${providerName}`, {
            cause: e
          })
        };
        return;
      }

      if (!response.ok) {
        yield { type: 'error', error: await mapHttpError(response, providerName) };
        return;
      }
      if (!response.body) {
        yield {
          type: 'error',
          error: atlasError('PROVIDER_INVALID_RESPONSE', `${providerName} returned no body`)
        };
        return;
      }

      if (route === 'responses') {
        yield* parseResponsesStream(response.body, request.signal, providerName);
      } else if (route === 'messages') {
        yield* parseAnthropicMessagesStream(response.body, request.signal, providerName);
      } else {
        yield* parseChatCompletionsStream(response.body, request.signal, providerName);
      }
    }
  };
};

const buildBody = (
  route: OpenCodeRoute,
  model: string,
  request: CompletionRequest
): Record<string, unknown> => {
  if (route === 'responses') {
    const { instructions, input } = toResponsesInput(request.messages);
    return {
      model,
      instructions,
      input,
      tools: (request.tools ?? []).map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false
      })),
      tool_choice: request.toolChoice ?? 'auto',
      parallel_tool_calls: false,
      ...(request.reasoning ? { reasoning: { effort: request.reasoning.effort } } : {}),
      store: false,
      stream: true,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {})
    };
  }

  if (route === 'messages') {
    const { systemText, messages } = toAnthropicMessages(request.messages);
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 8192,
      stream: true
    };
    if (systemText.length > 0) body['system'] = systemText;
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters
      }));
      if (request.toolChoice === 'required') body['tool_choice'] = { type: 'any' };
      else if (request.toolChoice === 'none') body['tool_choice'] = { type: 'none' };
      else body['tool_choice'] = { type: 'auto' };
    }
    if (request.reasoning) {
      const budget = request.reasoning.maxTokens ?? defaultThinkingBudget(request.reasoning.effort);
      body['thinking'] = { type: 'enabled', budget_tokens: budget };
      const current = body['max_tokens'] as number;
      if (current < budget + 4096) body['max_tokens'] = budget + 4096;
    }
    return body;
  }

  return {
    model,
    messages: request.messages.map((m) => {
      // Chat Completions convention: when an assistant turn called
      // tools, `content` is empty/null in the persisted history.
      // Several third-party models served behind this wire format
      // (DeepSeek, GLM, Kimi, Qwen, …) are trained on that
      // convention and will *re-emit* any pre-tool narration in the
      // next round if we feed it back to them — producing two ATLAS
      // replies in a row. The pre-tool text was already streamed
      // live to the user, so dropping it here is loss-free.
      const isAssistantToolCall =
        m.role === 'assistant' && Boolean(m.toolCalls && m.toolCalls.length > 0);
      const base: Record<string, unknown> = {
        role: m.role,
        content: isAssistantToolCall ? '' : m.content
      };
      if (m.toolCallId) base['tool_call_id'] = m.toolCallId;
      if (m.name) base['name'] = m.name;
      if (m.toolCalls && m.toolCalls.length > 0) {
        base['tool_calls'] = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments }
        }));
      }
      return base;
    }),
    stream: true,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters }
          })),
          ...(request.toolChoice ? { tool_choice: request.toolChoice } : {})
        }
      : {}),
    ...(request.reasoning
      ? {
          reasoning: {
            effort: request.reasoning.effort,
            ...(request.reasoning.maxTokens !== undefined
              ? { max_tokens: request.reasoning.maxTokens }
              : {})
          }
        }
      : {})
  };
};

async function* parseChatCompletionsStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  providerName: string
): AsyncGenerator<StreamEvent> {
  let lastUsage: TokenUsage | undefined;
  let lastFinish: string | null = null;
  const toolCalls = new Map<number, ToolCallAccumulator>();
  try {
    for await (const event of parseDataSse(body, signal)) {
      if (event === SSE_DONE) break;
      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(event) as OpenAIStreamChunk;
      } catch (e) {
        log.warn({ providerName, event, err: e }, 'failed to parse chat SSE chunk');
        continue;
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length > 0) yield { type: 'thinking', text: reasoning };
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        yield { type: 'delta', text: delta.content };
      }
      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const acc = toolCalls.get(idx) ?? { id: '', name: '', arguments: '', emitted: false };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        toolCalls.set(idx, acc);
        yield {
          type: 'tool_call_delta',
          index: idx,
          ...(tc.id ? { id: tc.id } : {}),
          ...(tc.function?.name ? { name: tc.function.name } : {}),
          ...(tc.function?.arguments ? { argumentsDelta: tc.function.arguments } : {})
        };
      }
      if (choice?.finish_reason) lastFinish = choice.finish_reason;
      if (chunk.usage) lastUsage = openAiUsage(chunk.usage);
    }
  } catch (e) {
    if (signal?.aborted) {
      yield { type: 'error', error: atlasError('CANCELLED', 'request cancelled') };
      return;
    }
    yield { type: 'error', error: atlasError('PROVIDER_NETWORK', `${providerName} stream interrupted`, { cause: e }) };
    return;
  }

  for (const [, acc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    if (acc.emitted || !acc.id || !acc.name) continue;
    acc.emitted = true;
    yield { type: 'tool_call', call: { id: acc.id, name: acc.name, arguments: acc.arguments } };
  }
  yield { type: 'done', finishReason: lastFinish, ...(lastUsage ? { usage: lastUsage } : {}) };
}

async function* parseResponsesStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  providerName: string
): AsyncGenerator<StreamEvent> {
  const toolCalls = new Map<string, ToolCallAccumulator>();
  let lastUsage: TokenUsage | undefined;
  let finishReason: string | null = null;
  try {
    for await (const evt of parseTypedSse(body, signal)) {
      const type = typeof evt['type'] === 'string' ? evt['type'] : '';
      if (type === 'response.output_text.delta') {
        const text = typeof evt['delta'] === 'string' ? evt['delta'] : '';
        if (text.length > 0) yield { type: 'delta', text };
        continue;
      }
      if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning.delta') {
        const text = typeof evt['delta'] === 'string' ? evt['delta'] : '';
        if (text.length > 0) yield { type: 'thinking', text };
        continue;
      }
      if (type === 'response.output_item.added') {
        const item = evt['item'] as Record<string, unknown> | undefined;
        if (item?.['type'] === 'function_call') {
          const id = String(item['id'] ?? item['call_id'] ?? '');
          if (id) toolCalls.set(id, { id, name: String(item['name'] ?? ''), arguments: '', emitted: false });
        }
        continue;
      }
      if (type === 'response.function_call_arguments.delta') {
        const id = String(evt['item_id'] ?? '');
        const delta = typeof evt['delta'] === 'string' ? evt['delta'] : '';
        const acc = toolCalls.get(id);
        if (acc && delta.length > 0) {
          acc.arguments += delta;
          yield { type: 'tool_call_delta', index: 0, id: acc.id, ...(acc.name ? { name: acc.name } : {}), argumentsDelta: delta };
        }
        continue;
      }
      if (type === 'response.output_item.done') {
        const item = evt['item'] as Record<string, unknown> | undefined;
        if (item?.['type'] === 'function_call') {
          const id = String(item['id'] ?? item['call_id'] ?? '');
          const acc = toolCalls.get(id);
          if (acc && !acc.emitted) {
            acc.emitted = true;
            yield {
              type: 'tool_call',
              call: {
                id: typeof item['call_id'] === 'string' ? item['call_id'] : acc.id,
                name: typeof item['name'] === 'string' ? item['name'] : acc.name,
                arguments: typeof item['arguments'] === 'string' ? item['arguments'] : acc.arguments
              }
            };
          }
        }
        continue;
      }
      if (type === 'response.completed') {
        const resp = evt['response'] as Record<string, unknown> | undefined;
        const usage = resp?.['usage'] as Record<string, unknown> | undefined;
        if (usage) lastUsage = responsesUsage(usage);
        finishReason = 'stop';
        continue;
      }
      if (type === 'response.failed' || type === 'error') {
        const err = evt['error'] as Record<string, unknown> | undefined;
        yield {
          type: 'error',
          error: atlasError(
            'PROVIDER_INVALID_RESPONSE',
            (err && typeof err['message'] === 'string' && err['message']) || `${providerName} stream error`
          )
        };
        return;
      }
    }
  } catch (e) {
    if (signal?.aborted) {
      yield { type: 'error', error: atlasError('CANCELLED', 'request cancelled') };
      return;
    }
    yield { type: 'error', error: atlasError('PROVIDER_NETWORK', `${providerName} stream interrupted`, { cause: e }) };
    return;
  }
  yield { type: 'done', finishReason, ...(lastUsage ? { usage: lastUsage } : {}) };
}

interface AnthropicSseEvent {
  readonly type: string;
  readonly data: Record<string, unknown> | null;
}

async function* parseAnthropicMessagesStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  providerName: string
): AsyncGenerator<StreamEvent> {
  const blocks = new Map<number, { type: 'text' | 'thinking' | 'tool_use'; toolId?: string; toolName?: string; argsBuf: string }>();
  let usage: TokenUsage | undefined;
  try {
    for await (const evt of parseAnthropicSse(body, signal)) {
      switch (evt.type) {
        case 'message_start': {
          const msg = evt.data?.['message'] as Record<string, unknown> | undefined;
          const u = msg?.['usage'] as Record<string, unknown> | undefined;
          if (u) usage = mergeUsage(usage, anthropicUsage(u));
          break;
        }
        case 'content_block_start': {
          const idx = numberOr(evt.data?.['index'], -1);
          const block = evt.data?.['content_block'] as Record<string, unknown> | undefined;
          if (!block) break;
          const t = String(block['type']);
          if (t === 'text') blocks.set(idx, { type: 'text', argsBuf: '' });
          else if (t === 'thinking') blocks.set(idx, { type: 'thinking', argsBuf: '' });
          else if (t === 'tool_use') {
            blocks.set(idx, {
              type: 'tool_use',
              toolId: String(block['id'] ?? ''),
              toolName: String(block['name'] ?? ''),
              argsBuf: ''
            });
          }
          break;
        }
        case 'content_block_delta': {
          const idx = numberOr(evt.data?.['index'], -1);
          const delta = evt.data?.['delta'] as Record<string, unknown> | undefined;
          if (!delta) break;
          const dt = String(delta['type']);
          if (dt === 'text_delta') {
            const text = String(delta['text'] ?? '');
            if (text.length > 0) yield { type: 'delta', text };
          } else if (dt === 'thinking_delta') {
            const text = String(delta['thinking'] ?? '');
            if (text.length > 0) yield { type: 'thinking', text };
          } else if (dt === 'input_json_delta') {
            const partial = String(delta['partial_json'] ?? '');
            const acc = blocks.get(idx);
            if (acc?.type === 'tool_use') {
              acc.argsBuf += partial;
              yield {
                type: 'tool_call_delta',
                index: idx,
                ...(acc.toolId ? { id: acc.toolId } : {}),
                ...(acc.toolName ? { name: acc.toolName } : {}),
                argumentsDelta: partial
              };
            }
          }
          break;
        }
        case 'content_block_stop': {
          const idx = numberOr(evt.data?.['index'], -1);
          const acc = blocks.get(idx);
          if (acc?.type === 'tool_use' && acc.toolId && acc.toolName) {
            yield { type: 'tool_call', call: { id: acc.toolId, name: acc.toolName, arguments: acc.argsBuf || '{}' } };
          }
          break;
        }
        case 'message_delta': {
          const u = evt.data?.['usage'] as Record<string, unknown> | undefined;
          if (u) usage = mergeUsage(usage, anthropicUsage(u));
          break;
        }
        case 'message_stop':
          yield { type: 'done', finishReason: 'stop', ...(usage ? { usage } : {}) };
          return;
        case 'error':
          yield { type: 'error', error: atlasError('PROVIDER_INVALID_RESPONSE', `${providerName} stream error`, { context: evt.data ?? {} }) };
          return;
        default:
          break;
      }
    }
  } catch (e) {
    if (signal?.aborted) {
      yield { type: 'error', error: atlasError('CANCELLED', 'request cancelled') };
      return;
    }
    yield { type: 'error', error: atlasError('PROVIDER_NETWORK', `${providerName} stream interrupted`, { cause: e }) };
    return;
  }
  yield { type: 'done', finishReason: 'stop', ...(usage ? { usage } : {}) };
}

const defaultThinkingBudget = (effort: 'low' | 'medium' | 'high'): number => {
  switch (effort) {
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
      return 16_384;
  }
};

const toResponsesInput = (
  messages: readonly Message[]
): { instructions: string; input: readonly ResponsesInputItem[] } => {
  const sys: string[] = [];
  const input: ResponsesInputItem[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) sys.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId ?? '', output: m.content });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      if (m.content) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      }
      for (const tc of m.toolCalls) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments });
      }
      continue;
    }
    input.push({
      type: 'message',
      role: m.role,
      content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }]
    });
  }
  return { instructions: sys.join('\n\n'), input };
};

const toAnthropicMessages = (
  messages: readonly Message[]
): { systemText: string; messages: AnthropicMessage[] } => {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content.trim().length > 0) systemParts.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }] });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content.trim().length > 0) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        let parsed: unknown = {};
        try {
          parsed = tc.arguments.length > 0 ? JSON.parse(tc.arguments) : {};
        } catch {
          parsed = {};
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parsed });
      }
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: 'user', content: m.content });
  }
  return { systemText: systemParts.join('\n\n'), messages: out };
};

const numberOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const openAiUsage = (usage: NonNullable<OpenAIStreamChunk['usage']>): TokenUsage => {
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
    ...(typeof cachedTokens === 'number' && cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {})
  };
};

const responsesUsage = (usage: Record<string, unknown>): TokenUsage => {
  const reasoningTokens = (usage['output_tokens_details'] as Record<string, unknown> | undefined)?.['reasoning_tokens'];
  const cachedTokens = (usage['input_tokens_details'] as Record<string, unknown> | undefined)?.['cached_tokens'];
  return {
    promptTokens: numberOr(usage['input_tokens'], 0),
    completionTokens: numberOr(usage['output_tokens'], 0),
    totalTokens: numberOr(usage['total_tokens'], 0),
    ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
    ...(typeof cachedTokens === 'number' && cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {})
  };
};

const anthropicUsage = (u: Record<string, unknown>): Partial<TokenUsage> => {
  const cacheCreation = numberOr(u['cache_creation_input_tokens'], 0);
  const cacheRead = numberOr(u['cache_read_input_tokens'], 0);
  return {
    ...(typeof u['input_tokens'] === 'number'
      ? { promptTokens: numberOr(u['input_tokens'], 0) + cacheRead + cacheCreation }
      : {}),
    ...(typeof u['output_tokens'] === 'number' ? { completionTokens: numberOr(u['output_tokens'], 0) } : {}),
    ...(cacheCreation > 0 ? { cacheCreationTokens: cacheCreation } : {}),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {})
  };
};

const mergeUsage = (prev: TokenUsage | undefined, next: Partial<TokenUsage>): TokenUsage => {
  const merged: Partial<TokenUsage> = { ...(prev ?? {}), ...next };
  const promptTokens = merged.promptTokens ?? 0;
  const completionTokens = merged.completionTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(merged.reasoningTokens !== undefined ? { reasoningTokens: merged.reasoningTokens } : {}),
    ...(merged.cacheCreationTokens !== undefined ? { cacheCreationTokens: merged.cacheCreationTokens } : {}),
    ...(merged.cacheReadTokens !== undefined ? { cacheReadTokens: merged.cacheReadTokens } : {})
  };
};

async function* parseDataSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw atlasError('CANCELLED', 'stream cancelled');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let eolIndex: number;
      while ((eolIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, eolIndex).replace(/\r$/, '');
        buffer = buffer.slice(eolIndex + 1);
        if (line.length === 0 || line.startsWith(':')) continue;
        if (!line.startsWith(SSE_DATA_PREFIX)) continue;
        const payload = line.slice(SSE_DATA_PREFIX.length).trimStart();
        if (payload.length > 0) yield payload;
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith(SSE_DATA_PREFIX)) {
      const payload = tail.slice(SSE_DATA_PREFIX.length).trimStart();
      if (payload.length > 0) yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* parseTypedSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let buffer = '';
  let currentEvent = '';
  let currentData = '';
  try {
    while (true) {
      if (signal?.aborted) throw atlasError('CANCELLED', 'stream cancelled');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (rawLine.length === 0) {
          if (currentData.length > 0) {
            const payload = currentData;
            const evtName = currentEvent;
            currentData = '';
            currentEvent = '';
            try {
              const obj = JSON.parse(payload) as Record<string, unknown>;
              if (!('type' in obj) && evtName) obj['type'] = evtName;
              yield obj;
            } catch (e) {
              log.warn({ payload: payload.slice(0, 256), err: e }, 'OpenCode responses SSE parse failure');
            }
          } else {
            currentEvent = '';
          }
          continue;
        }
        if (rawLine.startsWith(':')) continue;
        if (rawLine.startsWith(SSE_EVENT_PREFIX)) {
          currentEvent = rawLine.slice(SSE_EVENT_PREFIX.length).trim();
          continue;
        }
        if (rawLine.startsWith(SSE_DATA_PREFIX)) {
          const chunk = rawLine.slice(SSE_DATA_PREFIX.length).trimStart();
          currentData = currentData.length === 0 ? chunk : `${currentData}\n${chunk}`;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function* parseAnthropicSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<AnthropicSseEvent> {
  for await (const evt of parseTypedSse(body, signal)) {
    const type = typeof evt['type'] === 'string' ? evt['type'] : 'message';
    yield { type, data: evt };
  }
}

const mapHttpError = async (response: Response, providerName: string): Promise<AtlasError> => {
  const bodyText = await response.text().catch(() => '');
  const ctx = { status: response.status, body: bodyText.slice(0, 1024) };
  if (response.status === 401 || response.status === 403) {
    return atlasError('PROVIDER_AUTH_FAILED', `${providerName} auth failed (${response.status})`, { context: ctx });
  }
  if (response.status === 429) {
    return atlasError('PROVIDER_RATE_LIMITED', `${providerName} rate limit exceeded`, { context: ctx });
  }
  if (response.status === 404) {
    return atlasError('PROVIDER_MODEL_UNKNOWN', `${providerName} model not found`, { context: ctx });
  }
  return atlasError('PROVIDER_INVALID_RESPONSE', `${providerName} returned HTTP ${response.status}`, { context: ctx });
};
