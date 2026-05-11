/**
 * ChatGPT / Codex provider — speaks the OpenAI Responses API hosted at
 * `https://chatgpt.com/backend-api/codex/responses`. This is the same
 * endpoint the open-source Codex CLI uses; it's gated by ChatGPT OAuth
 * (Plus/Pro/Team plans) rather than a paid OpenAI API key.
 *
 * Wire format diverges from the OpenAI/OpenRouter chat-completions
 * shape:
 *   - System prompts go into `instructions` (string).
 *   - Conversation history is `input` — an array of typed items
 *     (`message`, `function_call`, `function_call_output`, ...).
 *   - Tools are `function` items with a flat `name`/`parameters`/`strict`
 *     shape (no `type: "function"` wrapper).
 *   - SSE events are typed (`response.output_text.delta`,
 *     `response.function_call_arguments.delta`,
 *     `response.output_item.done`, `response.completed`, ...).
 *
 * Tokens may expire; on 401 we transparently refresh once via
 * `refreshCodexTokens` and retry.
 */
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import { CODEX_ORIGINATOR, refreshCodexTokens } from './codex-oauth.js';
import {
  contentToString,
  type CompletionRequest,
  type Message,
  type Provider,
  type StreamEvent,
  type TokenUsage,
  type ToolCall
} from './types.js';

const log = childLogger('provider:codex');

const SSE_DATA_PREFIX = 'data:';
const SSE_EVENT_PREFIX = 'event:';
const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';

export interface CodexProviderTokenStore {
  /** Return the current token bundle. Called before every request. */
  read(): Promise<CodexTokenSnapshot> | CodexTokenSnapshot;
  /**
   * Persist a fresh bundle returned from a refresh. Implementations
   * should write to ~/.atlas/config.yaml (or equivalent) so subsequent
   * processes pick up the new token.
   */
  write(next: CodexTokenSnapshot): Promise<void> | void;
}

export interface CodexTokenSnapshot {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly accountId?: string;
  /** epoch ms when the access token expires. */
  readonly expiresAt?: number;
}

export interface CodexProviderOptions {
  readonly tokens: CodexProviderTokenStore;
  readonly baseUrl?: string;
  /** Override fetch (testing). */
  readonly fetch?: typeof fetch;
  /**
   * Stable session id sent on every request so the backend can stitch
   * turns together. Defaults to a process-lifetime UUID.
   */
  readonly sessionId?: string;
}

interface ResponsesInputItem {
  readonly type: 'message' | 'function_call' | 'function_call_output';
  readonly role?: 'user' | 'assistant' | 'system';
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string; readonly image_url?: string }>;
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
  readonly output?: string;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
  emitted: boolean;
}

const randomSessionId = (): string => {
  // Crypto-grade UUIDv4. Codex backend accepts any uuid-shaped string.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const createCodexProvider = (options: CodexProviderOptions): Provider => {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;
  const sessionId = options.sessionId ?? randomSessionId();

  const buildHeaders = (snap: CodexTokenSnapshot): Record<string, string> => {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${snap.accessToken}`,
      'openai-beta': 'responses=experimental',
      originator: CODEX_ORIGINATOR,
      session_id: sessionId
    };
    if (snap.accountId) h['chatgpt-account-id'] = snap.accountId;
    return h;
  };

  return {
    name: 'openai-codex',
    async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
      const url = `${baseUrl}/responses`;

      const { instructions, input } = toResponsesInput(request.messages);
      // Body shape mirrors codex-rs `ResponsesApiRequest`:
      // model, instructions, input, tools, tool_choice (always),
      // parallel_tool_calls, reasoning?, store=false, stream=true,
      // include (always — empty when no reasoning), prompt_cache_key.
      const tools = (request.tools ?? []).map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false
      }));
      const reasoning = request.reasoning
        ? { effort: request.reasoning.effort, summary: 'auto' as const }
        : undefined;
      const include = reasoning ? ['reasoning.encrypted_content'] : [];
      const body = JSON.stringify({
        model: request.model,
        instructions,
        input,
        tools,
        tool_choice: request.toolChoice ?? 'auto',
        parallel_tool_calls: false,
        ...(reasoning ? { reasoning } : {}),
        store: false,
        stream: true,
        include,
        prompt_cache_key: sessionId,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {})
      });

      let snap = await Promise.resolve(options.tokens.read());
      let response: Response | undefined;
      let triedRefresh = false;

      // Two-attempt loop: send → if 401, refresh → resend once.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await doFetch(url, {
            method: 'POST',
            headers: buildHeaders(snap),
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
            error: atlasError('PROVIDER_NETWORK', 'network error contacting Codex backend', {
              cause: e
            })
          };
          return;
        }

        if (response.status !== 401 || triedRefresh || !snap.refreshToken) break;

        log.warn('codex 401 — attempting token refresh');
        triedRefresh = true;
        const refreshed = await refreshCodexTokens(snap.refreshToken);
        if (!refreshed.ok) {
          yield { type: 'error', error: refreshed.error };
          return;
        }
        snap = {
          accessToken: refreshed.value.accessToken,
          ...(refreshed.value.refreshToken !== undefined
            ? { refreshToken: refreshed.value.refreshToken }
            : {}),
          ...(refreshed.value.idToken !== undefined ? { idToken: refreshed.value.idToken } : {}),
          ...(snap.accountId !== undefined ? { accountId: snap.accountId } : {}),
          expiresAt: refreshed.value.expiresAt
        };
        try {
          await Promise.resolve(options.tokens.write(snap));
        } catch (e) {
          log.warn({ err: e }, 'failed to persist refreshed codex tokens');
        }
      }

      if (!response) {
        yield {
          type: 'error',
          error: atlasError('PROVIDER_NETWORK', 'no response from Codex backend')
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
          error: atlasError('PROVIDER_INVALID_RESPONSE', 'Codex backend returned no body')
        };
        return;
      }

      const toolCalls = new Map<string, ToolCallAccumulator>();
      let lastUsage: TokenUsage | undefined;
      let finishReason: string | null = null;

      try {
        for await (const evt of parseSseEvents(response.body, request.signal)) {
          // The Responses API SSE stream is event-typed. We only act on
          // a small subset; everything else is observability noise.
          const type = typeof evt['type'] === 'string' ? evt['type'] : '';

          if (type === 'response.output_text.delta') {
            const text = typeof evt['delta'] === 'string' ? evt['delta'] : '';
            if (text.length > 0) yield { type: 'delta', text };
            continue;
          }
          if (
            type === 'response.reasoning_summary_text.delta' ||
            type === 'response.reasoning.delta'
          ) {
            const text = typeof evt['delta'] === 'string' ? evt['delta'] : '';
            if (text.length > 0) yield { type: 'thinking', text };
            continue;
          }
          if (type === 'response.output_item.added') {
            const item = evt['item'] as Record<string, unknown> | undefined;
            if (item && item['type'] === 'function_call') {
              const id = String(item['id'] ?? item['call_id'] ?? '');
              const name = String(item['name'] ?? '');
              if (id) toolCalls.set(id, { id, name, arguments: '', emitted: false });
            }
            continue;
          }
          if (type === 'response.function_call_arguments.delta') {
            const id = String(evt['item_id'] ?? '');
            const delta = typeof evt['delta'] === 'string' ? evt['delta'] : '';
            const acc = toolCalls.get(id);
            if (acc && delta.length > 0) {
              acc.arguments += delta;
              yield {
                type: 'tool_call_delta',
                index: 0,
                id: acc.id,
                ...(acc.name ? { name: acc.name } : {}),
                argumentsDelta: delta
              };
            }
            continue;
          }
          if (type === 'response.output_item.done') {
            const item = evt['item'] as Record<string, unknown> | undefined;
            if (item && item['type'] === 'function_call') {
              const id = String(item['id'] ?? item['call_id'] ?? '');
              const acc = toolCalls.get(id);
              if (acc && !acc.emitted) {
                acc.emitted = true;
                // Codex sends the final arguments string on the done event;
                // prefer it over our accumulator if present.
                const finalArgs =
                  typeof item['arguments'] === 'string' ? item['arguments'] : acc.arguments;
                const callId =
                  typeof item['call_id'] === 'string' ? item['call_id'] : acc.id;
                const call: ToolCall = {
                  id: callId,
                  name: typeof item['name'] === 'string' ? item['name'] : acc.name,
                  arguments: finalArgs
                };
                yield { type: 'tool_call', call };
              }
            }
            continue;
          }
          if (type === 'response.completed') {
            const resp = evt['response'] as Record<string, unknown> | undefined;
            const usage = resp?.['usage'] as Record<string, unknown> | undefined;
            if (usage) {
              const reasoningTokens =
                (usage['output_tokens_details'] as Record<string, unknown> | undefined)?.[
                  'reasoning_tokens'
                ];
              const cachedTokens =
                (usage['input_tokens_details'] as Record<string, unknown> | undefined)?.[
                  'cached_tokens'
                ];
              lastUsage = {
                promptTokens: numberOr(usage['input_tokens'], 0),
                completionTokens: numberOr(usage['output_tokens'], 0),
                totalTokens: numberOr(usage['total_tokens'], 0),
                ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
                ...(typeof cachedTokens === 'number' && cachedTokens > 0
                  ? { cacheReadTokens: cachedTokens }
                  : {})
              };
            }
            finishReason = 'stop';
            continue;
          }
          if (type === 'response.failed' || type === 'error') {
            const err = evt['error'] as Record<string, unknown> | undefined;
            const msg =
              (err && typeof err['message'] === 'string' && err['message']) ||
              'Codex stream returned an error event';
            yield {
              type: 'error',
              error: atlasError('PROVIDER_INVALID_RESPONSE', msg)
            };
            return;
          }
        }
      } catch (e) {
        if (request.signal?.aborted) {
          yield { type: 'error', error: atlasError('CANCELLED', 'request cancelled') };
          return;
        }
        yield {
          type: 'error',
          error: atlasError('PROVIDER_NETWORK', 'codex stream interrupted', { cause: e })
        };
        return;
      }

      yield {
        type: 'done',
        finishReason,
        ...(lastUsage ? { usage: lastUsage } : {})
      };
    }
  };
};

const numberOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' ? v : fallback;

/**
 * Translate the generic chat history into Responses-API input items.
 * `system` messages are concatenated into the top-level `instructions`
 * field; everything else becomes a typed input item.
 */
const toResponsesInput = (
  messages: readonly Message[]
): { instructions: string; input: readonly ResponsesInputItem[] } => {
  const sys: string[] = [];
  const items: ResponsesInputItem[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : contentToString(m.content);
      if (text) sys.push(text);
      continue;
    }
    if (m.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: m.toolCallId ?? '',
        output: typeof m.content === 'string' ? m.content : contentToString(m.content)
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      // Replay each tool call as its own function_call item.
      const text = typeof m.content === 'string' ? m.content : contentToString(m.content);
      if (text) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }]
        });
      }
      for (const tc of m.toolCalls) {
        items.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments
        });
      }
      continue;
    }
    if (typeof m.content === 'string') {
      items.push({
        type: 'message',
        role: m.role,
        content: [
          {
            type: m.role === 'assistant' ? 'output_text' : 'input_text',
            text: m.content
          }
        ]
      });
    } else {
      const content: ResponsesInputItem['content'] = m.content.map((b) =>
        b.type === 'text'
          ? { type: 'input_text', text: b.text }
          : { type: 'input_image', image_url: `data:${b.mediaType};base64,${b.base64}` }
      );
      items.push({ type: 'message', role: m.role, content });
    }
  }
  return { instructions: sys.join('\n\n'), input: items };
};

const mapHttpError = async (response: Response): Promise<AtlasError> => {
  const bodyText = await response.text().catch(() => '');
  const ctx = { status: response.status, body: bodyText.slice(0, 1024) };
  if (response.status === 401 || response.status === 403) {
    return atlasError(
      'PROVIDER_AUTH_FAILED',
      `Codex auth failed (${response.status}) — sign in again via /config`,
      { context: ctx }
    );
  }
  if (response.status === 429) {
    return atlasError('PROVIDER_RATE_LIMITED', 'Codex backend rate limit exceeded', {
      context: ctx
    });
  }
  if (response.status === 404) {
    return atlasError('PROVIDER_MODEL_UNKNOWN', 'Codex model not found', { context: ctx });
  }
  // Surface a snippet of the response body so misconfigured fields
  // (the Responses API returns descriptive 400s) are visible in the UI.
  const snippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 300);
  return atlasError(
    'PROVIDER_INVALID_RESPONSE',
    `Codex backend returned HTTP ${response.status}${snippet ? ` — ${snippet}` : ''}`,
    { context: ctx }
  );
};

/**
 * Parse the typed-event SSE stream. Each event has an `event:` line
 * followed by one or more `data:` lines; we coalesce data lines and
 * yield the JSON-decoded payload (with `type` injected from the event
 * header when missing).
 */
async function* parseSseEvents(
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
          // Blank line = dispatch the accumulated event.
          if (currentData.length > 0) {
            const payload = currentData;
            currentData = '';
            const evtName = currentEvent;
            currentEvent = '';
            try {
              const obj = JSON.parse(payload) as Record<string, unknown>;
              if (!('type' in obj) && evtName) obj['type'] = evtName;
              yield obj;
            } catch (e) {
              log.warn({ payload: payload.slice(0, 256), err: e }, 'codex SSE parse failure');
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
          continue;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
