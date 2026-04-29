/**
 * OpenRouter provider — speaks the OpenAI-compatible /chat/completions
 * SSE protocol. Any model OpenRouter exposes is selectable by id
 * (e.g. "anthropic/claude-sonnet-4", "moonshotai/kimi-k2.6").
 *
 * Tests inject a custom `fetch` to avoid network access.
 */
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import type {
  CompletionRequest,
  Provider,
  StreamEvent,
  ToolCall,
  TokenUsage
} from './types.js';

const log = childLogger('provider:openrouter');

export interface OpenRouterProviderOptions {
  readonly apiKey: string;
  /**
   * Additional keys to fall back on if the primary returns 401/429.
   * Tried in order; the first key that succeeds wins.
   */
  readonly fallbackKeys?: readonly string[];
  readonly baseUrl?: string;
  readonly referer?: string;
  readonly title?: string;
  /** Override fetch (testing). Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
}

interface OpenAIStreamToolCallDelta {
  readonly index?: number;
  readonly id?: string;
  readonly type?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

interface OpenAIStreamChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: {
      readonly content?: string | null;
      /** Anthropic-on-OpenRouter emits reasoning under this field. */
      readonly reasoning?: string | null;
      /** Some routes (e.g. OpenAI) use `reasoning_content`. */
      readonly reasoning_content?: string | null;
      readonly tool_calls?: ReadonlyArray<OpenAIStreamToolCallDelta>;
    };
    readonly finish_reason?: string | null;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
    readonly completion_tokens_details?: {
      readonly reasoning_tokens?: number;
    };
  };
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
  emitted: boolean;
}

const SSE_DATA_PREFIX = 'data:';
const SSE_DONE = '[DONE]';

export const createOpenRouterProvider = (
  options: OpenRouterProviderOptions
): Provider => {
  const baseUrl = (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;

  return {
    name: 'openrouter',
    async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
      const url = `${baseUrl}/chat/completions`;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${options.apiKey}`
      };
      if (options.referer) headers['http-referer'] = options.referer;
      if (options.title) headers['x-title'] = options.title;

      const body = JSON.stringify({
        model: request.model,
        ...(request.fallbackModels && request.fallbackModels.length > 0
          ? { models: [request.model, ...request.fallbackModels] }
          : {}),
        messages: request.messages.map((m) => {
          // OpenAI/OpenRouter wire format: tool_calls on assistant messages,
          // tool_call_id on tool-role replies.
          const base: Record<string, unknown> = { role: m.role, content: m.content };
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
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters
                }
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
      });

      const keysToTry: readonly string[] = [
        options.apiKey,
        ...(options.fallbackKeys ?? [])
      ].filter((k): k is string => typeof k === 'string' && k.length > 0);

      let response: Response | undefined;
      let lastError: AtlasError | undefined;
      for (let i = 0; i < keysToTry.length; i += 1) {
        const key = keysToTry[i] ?? '';
        headers['authorization'] = `Bearer ${key}`;
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
          lastError = atlasError('PROVIDER_NETWORK', 'network error contacting OpenRouter', {
            cause: e
          });
          continue;
        }
        // Only rotate on auth/quota errors. 5xx and 4xx-other surface immediately.
        if (response.status === 401 || response.status === 429) {
          if (i < keysToTry.length - 1) {
            log.warn(
              { status: response.status, keyIndex: i, remaining: keysToTry.length - i - 1 },
              'openrouter key rejected, rotating to fallback'
            );
            lastError = await mapHttpError(response);
            continue;
          }
        }
        break;
      }

      if (!response) {
        yield {
          type: 'error',
          error:
            lastError ??
            atlasError('PROVIDER_NETWORK', 'network error contacting OpenRouter')
        };
        return;
      }

      if (!response.ok) {
        yield { type: 'error', error: await mapHttpError(response) };
        return;
      }

      if (!response.body) {
        yield {
          type: 'error',
          error: atlasError('PROVIDER_INVALID_RESPONSE', 'OpenRouter returned no body')
        };
        return;
      }

      let lastUsage: TokenUsage | undefined;
      let lastFinish: string | null = null;
      let sawDone = false;
      const toolCalls = new Map<number, ToolCallAccumulator>();

      try {
        for await (const event of parseSseStream(response.body, request.signal)) {
          if (event === SSE_DONE) {
            sawDone = true;
            break;
          }
          let chunk: OpenAIStreamChunk;
          try {
            chunk = JSON.parse(event) as OpenAIStreamChunk;
          } catch (e) {
            log.warn({ event, err: e }, 'failed to parse SSE chunk');
            continue;
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          const text = delta?.content;
          if (typeof text === 'string' && text.length > 0) {
            yield { type: 'delta', text };
          }
          const reasoning = delta?.reasoning ?? delta?.reasoning_content;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            yield { type: 'thinking', text: reasoning };
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const acc = toolCalls.get(idx) ?? {
                id: '',
                name: '',
                arguments: '',
                emitted: false
              };
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
              toolCalls.set(idx, acc);
              const deltaEvent: StreamEvent = {
                type: 'tool_call_delta',
                index: idx,
                ...(tc.id ? { id: tc.id } : {}),
                ...(tc.function?.name ? { name: tc.function.name } : {}),
                ...(tc.function?.arguments
                  ? { argumentsDelta: tc.function.arguments }
                  : {})
              };
              yield deltaEvent;
            }
          }
          if (choice?.finish_reason) {
            lastFinish = choice.finish_reason;
          }
          if (chunk.usage) {
            const reasoningTokens =
              chunk.usage.completion_tokens_details?.reasoning_tokens;
            lastUsage = {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0,
              ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {})
            };
          }
        }
      } catch (e) {
        if (request.signal?.aborted) {
          yield { type: 'error', error: atlasError('CANCELLED', 'request cancelled') };
          return;
        }
        yield {
          type: 'error',
          error: atlasError('PROVIDER_NETWORK', 'stream interrupted', { cause: e })
        };
        return;
      }

      // Flush any assembled tool calls before the terminal `done` event.
      for (const [, acc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        if (acc.emitted || !acc.id || !acc.name) continue;
        acc.emitted = true;
        const call: ToolCall = {
          id: acc.id,
          name: acc.name,
          arguments: acc.arguments
        };
        yield { type: 'tool_call', call };
      }

      if (!sawDone && lastFinish === null && lastUsage === undefined) {
        // Stream ended without any terminator at all — flag it but don't
        // throw; the caller may have received partial deltas already.
        log.debug('OpenRouter stream ended without [DONE] marker');
      }

      yield {
        type: 'done',
        finishReason: lastFinish,
        ...(lastUsage ? { usage: lastUsage } : {})
      };
    }
  };
};

const mapHttpError = async (response: Response): Promise<AtlasError> => {
  const bodyText = await response.text().catch(() => '');
  const ctx = { status: response.status, body: bodyText.slice(0, 1024) };
  if (response.status === 401 || response.status === 403) {
    return atlasError('PROVIDER_AUTH_FAILED', `OpenRouter auth failed (${response.status})`, {
      context: ctx
    });
  }
  if (response.status === 429) {
    return atlasError('PROVIDER_RATE_LIMITED', 'OpenRouter rate limit exceeded', {
      context: ctx
    });
  }
  if (response.status === 404) {
    return atlasError('PROVIDER_MODEL_UNKNOWN', 'OpenRouter model not found', {
      context: ctx
    });
  }
  return atlasError(
    'PROVIDER_INVALID_RESPONSE',
    `OpenRouter returned HTTP ${response.status}`,
    { context: ctx }
  );
};

/**
 * Minimal SSE parser. Yields the payload string of each `data:` line —
 * including the literal `[DONE]` sentinel so the caller can distinguish
 * stream completion from a parse failure.
 */
async function* parseSseStream(
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
      // SSE events are separated by blank lines; within an event each line
      // may carry its own field. We only care about `data:` payloads.
      while ((eolIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, eolIndex).replace(/\r$/, '');
        buffer = buffer.slice(eolIndex + 1);
        if (line.length === 0 || line.startsWith(':')) continue;
        if (!line.startsWith(SSE_DATA_PREFIX)) continue;
        const payload = line.slice(SSE_DATA_PREFIX.length).trimStart();
        if (payload.length === 0) continue;
        yield payload;
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
