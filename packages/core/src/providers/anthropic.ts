/**
 * Anthropic Messages API provider.
 *
 * Speaks the native /v1/messages SSE protocol so we get first-class
 * thinking blocks, parallel tool use, and Claude Code OAuth support.
 *
 * Auth modes:
 *   - `apiKey`     → standard `x-api-key` header (Anthropic API key).
 *   - `oauthToken` → `authorization: Bearer …` + `anthropic-beta: oauth-2025-04-20`,
 *                    matching what Claude Code itself sends.
 *
 * Translation from the Atlas (OpenAI-shaped) Message[] to Anthropic:
 *   - All `system` messages are concatenated into the top-level `system`.
 *   - `tool` role messages become a `user` turn with a single
 *     `tool_result` content block.
 *   - `assistant` messages with `toolCalls` become a content array
 *     containing optional text + one `tool_use` block per call.
 *   - Tool args are emitted as JSON strings; we parse them here for the
 *     Anthropic `input` field.
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

const log = childLogger('provider:anthropic');

export type AnthropicAuth =
  | { readonly kind: 'apiKey'; readonly apiKey: string; readonly fallbackKeys?: readonly string[] }
  | { readonly kind: 'oauth'; readonly accessToken: string };

export interface AnthropicProviderOptions {
  readonly auth: AnthropicAuth;
  readonly baseUrl?: string;
  readonly defaultMaxTokens?: number;
  readonly fetch?: typeof fetch;
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

const SSE_DATA_PREFIX = 'data:';
const SSE_EVENT_PREFIX = 'event:';

export const createAnthropicProvider = (
  options: AnthropicProviderOptions
): Provider => {
  const baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;

  return {
    name: 'anthropic',
    async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
      const url = `${baseUrl}/v1/messages`;
      const { systemText, messages } = translateMessages(request.messages);

      // Strip any "provider/" prefix that may have leaked from an OpenRouter-
      // shaped model id (e.g. "anthropic/claude-sonnet-4-5" → "claude-sonnet-4-5").
      const model = request.model.includes('/')
        ? request.model.slice(request.model.lastIndexOf('/') + 1)
        : request.model;

      const body: Record<string, unknown> = {
        model,
        messages,
        max_tokens: request.maxTokens ?? options.defaultMaxTokens ?? 8192,
        stream: true
      };
      // Claude Code OAuth tokens are scoped to "Claude Code" and Anthropic
      // requires the system prompt to begin with the Claude Code identifier.
      // If we don't include it, OAuth requests are rate-limited (429 with
      // body "Error") regardless of the user's actual quota. We send `system`
      // as an array so the identifier block stays separate from the user's
      // own system prompt.
      // Always send `system` as a typed-block array so we can attach
      // `cache_control: ephemeral` to the last block. This makes the
      // (large, stable) system prompt a cached prefix on subsequent
      // turns — typically a 30–80% reduction in input tokens billed.
      if (options.auth.kind === 'oauth') {
        const blocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [
          {
            type: 'text',
            text: "You are Claude Code, Anthropic's official CLI for Claude."
          }
        ];
        if (systemText.length > 0) blocks.push({ type: 'text', text: systemText });
        const last = blocks[blocks.length - 1];
        if (last) last.cache_control = { type: 'ephemeral' };
        body['system'] = blocks;
      } else if (systemText.length > 0) {
        body['system'] = [
          { type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }
        ];
      }
      if (request.temperature !== undefined) body['temperature'] = request.temperature;
      if (request.tools && request.tools.length > 0) {
        // Prompt caching: tag the last tool with cache_control so the
        // entire tool catalog is cached as a single prefix block.
        // Saves ~90% on input tokens for the tools array on cache hits.
        const toolsArr = request.tools.map((t, i) => {
          const base: Record<string, unknown> = {
            name: t.name,
            description: t.description,
            input_schema: t.parameters
          };
          if (i === request.tools!.length - 1) {
            base['cache_control'] = { type: 'ephemeral' };
          }
          return base;
        });
        body['tools'] = toolsArr;
        if (request.toolChoice === 'required') body['tool_choice'] = { type: 'any' };
        else if (request.toolChoice === 'none') body['tool_choice'] = { type: 'none' };
        else body['tool_choice'] = { type: 'auto' };
      }
      if (request.reasoning) {
        const budget =
          request.reasoning.maxTokens ?? defaultThinkingBudget(request.reasoning.effort);
        body['thinking'] = {
          type: 'enabled',
          budget_tokens: budget
        };
        // Anthropic requires `max_tokens > thinking.budget_tokens` (the
        // budget is consumed *inside* max_tokens). Bump max_tokens so the
        // user actually has room for output on top of their thinking
        // budget. We add a 4k headroom for the visible reply.
        const current = body['max_tokens'] as number;
        const required = budget + 4096;
        if (current < required) body['max_tokens'] = required;
      }

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'anthropic-version': '2023-06-01'
      };
      if (options.auth.kind === 'apiKey') {
        headers['x-api-key'] = options.auth.apiKey;
      } else {
        headers['authorization'] = `Bearer ${options.auth.accessToken}`;
        // Required when using a Claude Code / Claude.ai OAuth token to call
        // the public API directly.
        headers['anthropic-beta'] = 'oauth-2025-04-20';
      }

      const apiKeysToTry: readonly string[] =
        options.auth.kind === 'apiKey'
          ? [options.auth.apiKey, ...(options.auth.fallbackKeys ?? [])].filter(
              (k): k is string => typeof k === 'string' && k.length > 0
            )
          : [];

      let response: Response | undefined;
      let lastError: AtlasError | undefined;
      log.debug({ model, authKind: options.auth.kind }, 'anthropic request');

      const attempts = options.auth.kind === 'apiKey' ? apiKeysToTry.length : 1;
      for (let i = 0; i < attempts; i += 1) {
        if (options.auth.kind === 'apiKey') {
          headers['x-api-key'] = apiKeysToTry[i] ?? '';
        }
        try {
          response = await doFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            ...(request.signal ? { signal: request.signal } : {})
          });
        } catch (e) {
          if (request.signal?.aborted) {
            yield { type: 'error', error: atlasError('CANCELLED', 'request cancelled') };
            return;
          }
          lastError = atlasError('PROVIDER_NETWORK', 'network error contacting Anthropic', {
            cause: e
          });
          response = undefined;
          continue;
        }
        if (
          options.auth.kind === 'apiKey' &&
          (response.status === 401 || response.status === 429) &&
          i < attempts - 1
        ) {
          log.warn(
            { status: response.status, keyIndex: i, remaining: attempts - i - 1 },
            'anthropic key rejected, rotating to fallback'
          );
          lastError = await mapHttpError(response);
          continue;
        }
        break;
      }

      if (!response) {
        yield {
          type: 'error',
          error:
            lastError ??
            atlasError('PROVIDER_NETWORK', 'network error contacting Anthropic')
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
          error: atlasError('PROVIDER_INVALID_RESPONSE', 'Anthropic returned no body')
        };
        return;
      }

      // Per-block accumulation. Anthropic streams via content_block_start/
      // content_block_delta/content_block_stop with an `index` per block.
      interface BlockAccum {
        type: 'text' | 'thinking' | 'tool_use';
        toolId?: string;
        toolName?: string;
        argsBuf: string;
      }
      const blocks = new Map<number, BlockAccum>();
      let usage: TokenUsage | undefined;

      try {
        for await (const evt of parseAnthropicSse(response.body, request.signal)) {
          switch (evt.type) {
            case 'message_start': {
              const msg = evt.data?.['message'] as Record<string, unknown> | undefined;
              const u = msg?.['usage'] as Record<string, unknown> | undefined;
              if (u) usage = mergeUsage(usage, mapUsage(u));
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
                if (acc && acc.type === 'tool_use') {
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
              if (acc && acc.type === 'tool_use' && acc.toolId && acc.toolName) {
                yield {
                  type: 'tool_call',
                  call: {
                    id: acc.toolId,
                    name: acc.toolName,
                    arguments: acc.argsBuf || '{}'
                  }
                };
              }
              break;
            }
            case 'message_delta': {
              const u = evt.data?.['usage'] as Record<string, unknown> | undefined;
              if (u) usage = mergeUsage(usage, mapUsage(u));
              break;
            }
            case 'message_stop':
              yield {
                type: 'done',
                finishReason: 'stop',
                ...(usage ? { usage } : {})
              };
              return;
            case 'error': {
              const msg =
                (evt.data?.['error'] as { message?: string } | undefined)?.message ?? 'anthropic error';
              yield {
                type: 'error',
                error: atlasError('PROVIDER_INVALID_RESPONSE', msg, { context: evt.data ?? {} })
              };
              return;
            }
            default:
              break;
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

      yield {
        type: 'done',
        finishReason: 'stop',
        ...(usage ? { usage } : {})
      };
    }
  };
};

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

const numberOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const mapUsage = (u: Record<string, unknown>): Partial<TokenUsage> => {
  const hasInput = typeof u['input_tokens'] === 'number';
  const hasOutput = typeof u['output_tokens'] === 'number';
  const cacheCreation = numberOr(u['cache_creation_input_tokens'], 0);
  const cacheRead = numberOr(u['cache_read_input_tokens'], 0);
  // Anthropic excludes cached tokens from input_tokens. Roll them in so
  // promptTokens reflects the full prompt size we sent.
  return {
    ...(hasInput
      ? { promptTokens: numberOr(u['input_tokens'], 0) + cacheRead + cacheCreation }
      : {}),
    ...(hasOutput ? { completionTokens: numberOr(u['output_tokens'], 0) } : {}),
    ...(cacheCreation > 0 ? { cacheCreationTokens: cacheCreation } : {}),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {})
  };
};

const mergeUsage = (
  prev: TokenUsage | undefined,
  next: Partial<TokenUsage>
): TokenUsage => {
  const merged: Partial<TokenUsage> = { ...(prev ?? {}), ...next };
  const promptTokens = merged.promptTokens ?? 0;
  const completionTokens = merged.completionTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(merged.reasoningTokens !== undefined ? { reasoningTokens: merged.reasoningTokens } : {}),
    ...(merged.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: merged.cacheCreationTokens }
      : {}),
    ...(merged.cacheReadTokens !== undefined ? { cacheReadTokens: merged.cacheReadTokens } : {})
  };
};

/**
 * Translate Atlas (OpenAI-style) message history into Anthropic shape.
 * - Pulls all `system` messages out into a single concatenated system string.
 * - `tool` role → `user` turn with tool_result block.
 * - `assistant` with toolCalls → content array with text + tool_use blocks.
 */
const translateMessages = (
  msgs: readonly Message[]
): { systemText: string; messages: AnthropicMessage[] } => {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const m of msgs) {
    if (m.role === 'system') {
      if (m.content.trim().length > 0) systemParts.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId ?? '',
            content: m.content
          }
        ]
      });
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
      // Anthropic rejects assistant turns containing an empty text
      // block ("text content blocks must be non-empty", HTTP 400).
      // This happens when an assistant turn was *only* an
      // `<atlas:question>` interaction request that we strip from the
      // session record post-turn — the persisted message has empty
      // content and no tool calls. Drop the whole turn rather than
      // emit a bad payload; the conversation reads fine without it
      // (the turn produced nothing observable for the user).
      if (blocks.length === 0) continue;
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    // user
    out.push({ role: 'user', content: m.content });
  }

  return { systemText: systemParts.join('\n\n'), messages: out };
};

interface AnthropicSseEvent {
  readonly type: string;
  readonly data: Record<string, unknown> | null;
}

async function* parseAnthropicSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncIterable<AnthropicSseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = '';
  let currentEvent = 'message';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      // SSE events end on a blank line. Process them one at a time.
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.length === 0) continue;
        if (line.startsWith(SSE_EVENT_PREFIX)) {
          currentEvent = line.slice(SSE_EVENT_PREFIX.length).trim();
          continue;
        }
        if (line.startsWith(SSE_DATA_PREFIX)) {
          const payload = line.slice(SSE_DATA_PREFIX.length).trim();
          if (payload === '[DONE]') return;
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            yield { type: currentEvent, data: parsed };
          } catch (e) {
            log.warn({ payload, err: e }, 'failed to parse anthropic SSE chunk');
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

const mapHttpError = async (res: Response): Promise<AtlasError> => {
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    /* noop */
  }
  // Try to extract the human-readable message from Anthropic's error envelope.
  // Shape: {"type":"error","error":{"type":"...","message":"..."}}
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const errObj = parsed['error'] as Record<string, unknown> | undefined;
    if (typeof errObj?.['message'] === 'string') detail = errObj['message'];
  } catch {
    detail = bodyText.slice(0, 300);
  }
  const suffix = detail ? `: ${detail}` : '';
  log.error({ status: res.status, body: bodyText.slice(0, 500) }, 'anthropic http error');
  if (res.status === 401 || res.status === 403) {
    return atlasError(
      'PROVIDER_AUTH_FAILED',
      `Anthropic auth failed (${res.status}). If using Claude Code OAuth, run \`claude\` to refresh.${suffix}`,
      { context: { status: res.status, body: bodyText.slice(0, 500) } }
    );
  }
  if (res.status === 429) {
    // Claude Code OAuth tokens often hit the user's daily Claude.ai quota
    // (separate from API key rate limits). The error body just says "Error".
    const note =
      detail.toLowerCase() === 'error'
        ? ' (Claude.ai daily limit may be exhausted — wait or switch to an API key)'
        : '';
    return atlasError('PROVIDER_RATE_LIMITED', `Anthropic rate-limited (429)${suffix}${note}`, {
      context: { body: bodyText.slice(0, 500) }
    });
  }
  if (res.status >= 500) {
    return atlasError('PROVIDER_NETWORK', `Anthropic ${res.status}${suffix}`, {
      context: { body: bodyText.slice(0, 500) }
    });
  }
  return atlasError('PROVIDER_INVALID_RESPONSE', `Anthropic HTTP ${res.status}${suffix}`, {
    context: { body: bodyText.slice(0, 500) }
  });
};
