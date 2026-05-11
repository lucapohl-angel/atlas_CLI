/**
 * Local / OpenAI-compatible provider.
 *
 * Talks to any HTTP server that speaks the OpenAI `/chat/completions`
 * SSE protocol. The default target is the **Ollama** daemon on
 * `http://localhost:11434/v1`, which exposes whatever models the user
 * has pulled (`ollama pull qwen2.5-coder:7b`, etc.).
 *
 * The same code path also serves:
 *   - LM Studio                   `http://localhost:1234/v1`
 *   - vLLM                        `http://<host>:8000/v1`
 *   - llama.cpp `server` binary   `http://localhost:8080/v1`
 *   - text-generation-webui       `http://localhost:5000/v1`
 *   - any future OpenAI-compatible endpoint
 *
 * Auth is optional: most local servers don't need it. Set `apiKey`
 * for endpoints that do (vLLM with `--api-key`, hosted gateways, …).
 *
 * Reasoning models that wrap their thoughts in `<think>…</think>` (the
 * DeepSeek-R1 and Qwen3 thinking families) are handled by extracting
 * those segments into `thinking` events.
 *
 * Tests inject a custom `fetch` to avoid network access.
 */
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import type { LocalProviderToolMode } from '../config/types.js';
import {
  contentToString,
  type CompletionRequest,
  type Provider,
  type StreamEvent,
  type ToolCall,
  type TokenUsage
} from './types.js';

const log = childLogger('provider:local');

export const LOCAL_HYBRID_TOOL_NAMES = [
  'read_file',
  'edit_file',
  'write_file',
  'terminal',
  'git',
  'todo',
  'clarify',
  'open_question'
] as const;

export const LOCAL_TOOL_MODE_SPECS: Record<
  LocalProviderToolMode,
  {
    readonly label: string;
    readonly requirements: string;
    readonly pros: string;
    readonly cons: string;
  }
> = {
  lite: {
    label: 'Lite',
    requirements: 'CPU ok, 4-8 GB RAM, 1.5B-7B models',
    pros: 'fastest and most reliable locally',
    cons: 'chat only; no model-driven tools or tool hooks'
  },
  hybrid: {
    label: 'Hybrid',
    requirements: '8-12 GB VRAM or strong CPU, 7B-14B models',
    pros: 'compact prompt plus core dev tools and hooks',
    cons: 'limited tool set; small models may still miss calls'
  },
  full: {
    label: 'Full Atlas',
    requirements: '24 GB+ VRAM or hosted server, 30B-70B+ models',
    pros: 'full Atlas prompt, tools, MCP, and hooks',
    cons: 'largest payload; highest timeout and quality risk locally'
  }
};

export interface LocalProviderOptions {
  /**
   * Base URL of the OpenAI-compatible endpoint. Must include the
   * `/v1` suffix when the server requires it (Ollama does, LM Studio
   * does, vLLM does). Defaults to Ollama.
   */
  readonly baseUrl?: string;
  /**
   * Optional bearer token. Most local servers don't need one.
   */
  readonly apiKey?: string;
  /**
   * Extra static headers (e.g. behind a private gateway).
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Override fetch (testing). Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Local prompt/tool mode. Defaults to `full` for direct API callers. */
  readonly toolMode?: LocalProviderToolMode;
  /** Legacy alias: true -> lite, false -> full when toolMode is unset. */
  readonly liteMode?: boolean;
  /**
   * Idle timeout per request in milliseconds. The timer resets on every
   * byte received from the server, so it only fires when the connection
   * truly stalls. Defaults to 300 000 (5 min) to handle cold model loads.
   */
  readonly requestTimeoutMs?: number;
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

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
/** Characters kept per message when compact local modes are active (~375 tokens). */
const LITE_SYSTEM_MAX_CHARS = 1_500;
/** How many recent non-system messages to keep when liteMode is active. */
const LITE_HISTORY_KEEP = 4;
/** How many recent non-system messages to keep when hybrid mode is active. */
const HYBRID_HISTORY_KEEP = 8;
/**
 * Replacement system prompt used in compact local modes. It must stay tiny, but
 * it still carries Atlas self-knowledge so small local models do not
 * fill identity questions with generic Anthropic/OpenAI/GPT priors.
 */
const compactSystemPrompt = (model: string, mode: 'lite' | 'hybrid'): string =>
  [
    'You are Atlas, the CLI coding assistant running in the user\'s terminal.',
    `Active model id: ${model}. Provider: local OpenAI-compatible server (usually Ollama).`,
    'If asked who you are, say you are Atlas. If asked which model is running, answer with the exact active model id above. Do not claim to be Claude, Anthropic, OpenAI, GPT-4, or ChatGPT unless that exact model id/provider says so.',
    mode === 'lite'
      ? 'Local lite mode is active: you do not have tools, tool results, or file access; answer only from the conversation and ask for details when needed.'
      : `Local hybrid mode is active: only these compact development tools may be available: ${LOCAL_HYBRID_TOOL_NAMES.join(', ')}. Use them sparingly and expect approval for writes or commands.`,
    'Atlas workflow summary: discover the task, plan carefully, build small focused changes, verify, then summarize.',
    'Keep responses short, direct, and useful.'
  ].join(' ');

const resolveLocalToolMode = (options: LocalProviderOptions): LocalProviderToolMode =>
  options.toolMode ??
  (options.liteMode === undefined ? 'full' : options.liteMode ? 'lite' : 'full');

export const createLocalProvider = (options: LocalProviderOptions = {}): Provider => {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;
  const toolMode = resolveLocalToolMode(options);
  const compactMode = toolMode === 'full' ? null : toolMode;
  const supportsToolCalling = toolMode !== 'lite';

  return {
    name: 'local',
    supportsToolCalling,
    ...(toolMode === 'hybrid' ? { allowedToolNames: LOCAL_HYBRID_TOOL_NAMES } : {}),
    async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
      const url = `${baseUrl}/chat/completions`;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(options.headers ?? {})
      };
      if (options.apiKey) {
        headers['authorization'] = `Bearer ${options.apiKey}`;
      }

      const includeToolProtocol = toolMode !== 'lite';

      // In compact local modes: collapse the entire orchestrator system
      // stack into a single tiny prompt and keep only recent turns. Lite
      // drops tool protocol turns; hybrid keeps them so tool results can
      // feed the follow-up request.
      let effectiveMessages: readonly typeof request.messages[number][];
      if (compactMode) {
        const nonSystem = request.messages.filter((m) => {
          if (m.role === 'system') return false;
          if (compactMode === 'lite' && m.role === 'tool') return false;
          if (
            compactMode === 'lite' &&
            m.role === 'assistant' &&
            m.toolCalls &&
            m.toolCalls.length > 0 &&
            !m.content
          ) {
            return false;
          }
          return true;
        });
        const keep = compactMode === 'hybrid' ? HYBRID_HISTORY_KEEP : LITE_HISTORY_KEEP;
        const recent = nonSystem.slice(-keep);
        // Truncate any individual message that's still huge (e.g. a pasted file).
        const trimmed = recent.map((m) => {
          const text = typeof m.content === 'string' ? m.content : contentToString(m.content);
          if (text.length > LITE_SYSTEM_MAX_CHARS) {
            return { ...m, content: text.slice(0, LITE_SYSTEM_MAX_CHARS) + '\n…[truncated]' };
          }
          return m;
        });
        effectiveMessages = [
          { role: 'system' as const, content: compactSystemPrompt(request.model, compactMode) },
          ...trimmed
        ];
      } else {
        effectiveMessages = request.messages;
      }

      if (compactMode) {
        const totalChars = effectiveMessages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : contentToString(m.content).length), 0);
        log.debug(
          { model: request.model, toolMode, msgCount: effectiveMessages.length, totalChars },
          'compact local payload built'
        );
      }

      const body = JSON.stringify({
        model: request.model,
        messages: effectiveMessages.map((m) => {
          const isAssistantToolCall =
            m.role === 'assistant' && Boolean(m.toolCalls && m.toolCalls.length > 0);
          const base: Record<string, unknown> = {
            role: m.role,
            content: mapContentToOpenAI(m.content, isAssistantToolCall)
          };
          if (m.toolCallId) base['tool_call_id'] = m.toolCallId;
          if (m.name) base['name'] = m.name;
          if (includeToolProtocol && m.toolCalls && m.toolCalls.length > 0) {
            base['tool_calls'] = m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments }
            }));
          }
          return base;
        }),
        stream: true,
        // Keep the model resident in RAM/VRAM for 30 min between requests
        // so the second prompt feels as instant as `ollama run` does in a
        // REPL. Ollama-specific field; the OpenAI shim forwards it. Other
        // OpenAI-compat servers (LM Studio, vLLM) ignore unknown fields.
        keep_alive: '30m',
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        ...(includeToolProtocol && request.tools && request.tools.length > 0
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
          : {})
      });

      // Idle-based timeout: a single AbortController re-armed every time
      // we get bytes from the server. Cold-loading a 7 b model on slow
      // hardware can take minutes — we only abort when the connection
      // truly stalls. Combined with the caller's signal so user
      // cancellation still wins.
      const idleMs = options.requestTimeoutMs ?? 300_000;
      const idleCtl = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> = setTimeout(
        () => idleCtl.abort(new Error('IDLE_TIMEOUT')),
        idleMs
      );
      const armIdle = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => idleCtl.abort(new Error('IDLE_TIMEOUT')),
          idleMs
        );
      };
      const disarmIdle = (): void => {
        clearTimeout(idleTimer);
      };
      const fetchSignal = request.signal
        ? AbortSignal.any([request.signal, idleCtl.signal])
        : idleCtl.signal;

      let response: Response;
      try {
        response = await doFetch(url, { method: 'POST', headers, body, signal: fetchSignal });
        armIdle();
      } catch (e) {
        disarmIdle();
        if (request.signal?.aborted) {
          yield { type: 'error', error: atlasError('CANCELLED', 'request cancelled') };
          return;
        }
        if (idleCtl.signal.aborted) {
          yield {
            type: 'error',
            error: atlasError(
              'PROVIDER_NETWORK',
              `local model server at ${baseUrl} did not respond within ${Math.round(idleMs / 1000)}s — model is likely cold-loading. Try \`ollama run ${request.model}\` once in a terminal to warm it up, then retry.`,
              { cause: e }
            )
          };
          return;
        }
        // Most common case: the daemon isn't running. Surface a friendly
        // hint pointing the user at the install/start step.
        yield {
          type: 'error',
          error: atlasError(
            'PROVIDER_NETWORK',
            `cannot reach local model server at ${baseUrl} — is Ollama running? (try \`ollama serve\`, or install from https://ollama.com/download)`,
            { cause: e }
          )
        };
        return;
      }

      if (!response.ok) {
        yield { type: 'error', error: await mapHttpError(response, baseUrl) };
        return;
      }

      if (!response.body) {
        yield {
          type: 'error',
          error: atlasError(
            'PROVIDER_INVALID_RESPONSE',
            'local model server returned no body'
          )
        };
        return;
      }

      let lastUsage: TokenUsage | undefined;
      let lastFinish: string | null = null;
      let sawDone = false;
      const toolCalls = new Map<number, ToolCallAccumulator>();
      const thinkState = createThinkExtractor();

      try {
        for await (const event of parseSseStream(response.body, fetchSignal)) {
          armIdle(); // re-arm: bytes are flowing
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

          // Native reasoning fields (some compatible gateways forward them).
          const reasoning = delta?.reasoning ?? delta?.reasoning_content;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            yield { type: 'thinking', text: reasoning };
          }

          const text = delta?.content;
          if (typeof text === 'string' && text.length > 0) {
            for (const segment of thinkState.feed(text)) {
              yield segment;
            }
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
            lastUsage = {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0
            };
          }
        }
      } catch (e) {
        disarmIdle();
        if (request.signal?.aborted) {
          yield { type: 'error', error: atlasError('CANCELLED', 'request cancelled') };
          return;
        }
        if (idleCtl.signal.aborted) {
          yield {
            type: 'error',
            error: atlasError(
              'PROVIDER_NETWORK',
              `local model stream stalled (no bytes for ${Math.round(idleMs / 1000)}s) — the model may have crashed or run out of memory`,
              { cause: e }
            )
          };
          return;
        }
        yield {
          type: 'error',
          error: atlasError('PROVIDER_NETWORK', 'stream interrupted', { cause: e })
        };
        return;
      }
      disarmIdle();

      // Flush any tail text that was inside an unterminated <think> tag.
      for (const segment of thinkState.flush()) {
        yield segment;
      }

      // Flush assembled tool calls.
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
        log.debug('local stream ended without [DONE] marker');
      }

      yield {
        type: 'done',
        finishReason: lastFinish,
        ...(lastUsage ? { usage: lastUsage } : {})
      };
    }
  };
};

const mapContentToOpenAI = (
  content: string | readonly import('./types.js').ContentBlock[],
  forceEmpty: boolean
): string | unknown[] => {
  if (forceEmpty) return '';
  if (typeof content === 'string') return content;
  return content.map((b) =>
    b.type === 'text'
      ? { type: 'text', text: b.text }
      : { type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.base64}` } }
  );
};

const mapHttpError = async (response: Response, baseUrl: string): Promise<AtlasError> => {
  const bodyText = await response.text().catch(() => '');
  const ctx = { status: response.status, body: bodyText.slice(0, 1024), baseUrl };
  if (response.status === 401 || response.status === 403) {
    return atlasError(
      'PROVIDER_AUTH_FAILED',
      `local server rejected credentials (${response.status})`,
      { context: ctx }
    );
  }
  if (response.status === 429) {
    return atlasError('PROVIDER_RATE_LIMITED', 'local server rate-limited request', {
      context: ctx
    });
  }
  if (response.status === 404) {
    return atlasError(
      'PROVIDER_MODEL_UNKNOWN',
      'model not found on local server — pull it first (e.g. `ollama pull <model>`)',
      { context: ctx }
    );
  }
  return atlasError(
    'PROVIDER_INVALID_RESPONSE',
    `local server returned HTTP ${response.status}`,
    { context: ctx }
  );
};

/**
 * Streaming `<think>…</think>` splitter. Many local reasoning models
 * (DeepSeek-R1, Qwen3 thinking variants, marco-o1) emit their chain
 * of thought inline wrapped in those tags. We split it out into
 * `thinking` events so the TUI can render it the same way it does
 * for native reasoning APIs.
 *
 * The state machine handles tag splits across SSE chunk boundaries
 * by buffering the trailing characters that *might* be the start of
 * a `<think` or `</think` tag.
 */
const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

interface ThinkExtractor {
  feed(text: string): readonly StreamEvent[];
  flush(): readonly StreamEvent[];
}

const createThinkExtractor = (): ThinkExtractor => {
  let inThink = false;
  let pending = '';

  /**
   * Length of the longest suffix of `s` that is a prefix of `tag`.
   * Used to decide how many trailing chars to hold back, in case a
   * partial tag spans the next SSE chunk.
   */
  const suffixPrefixLen = (s: string, tag: string): number => {
    const max = Math.min(s.length, tag.length - 1);
    for (let n = max; n > 0; n -= 1) {
      if (tag.startsWith(s.slice(s.length - n))) return n;
    }
    return 0;
  };

  const emit = (text: string): StreamEvent => ({
    type: inThink ? 'thinking' : 'delta',
    text
  });

  return {
    feed(text: string): readonly StreamEvent[] {
      pending += text;
      const out: StreamEvent[] = [];

      while (pending.length > 0) {
        const tag = inThink ? CLOSE_TAG : OPEN_TAG;
        const idx = pending.indexOf(tag);
        if (idx >= 0) {
          if (idx > 0) {
            const segment = pending.slice(0, idx);
            if (segment.length > 0) out.push(emit(segment));
          }
          pending = pending.slice(idx + tag.length);
          inThink = !inThink;
          continue;
        }
        // No full tag yet — emit everything except a potential partial
        // tag at the tail.
        const hold = suffixPrefixLen(pending, tag);
        const safe = pending.slice(0, pending.length - hold);
        if (safe.length > 0) out.push(emit(safe));
        pending = pending.slice(pending.length - hold);
        break;
      }
      return out;
    },
    flush(): readonly StreamEvent[] {
      if (pending.length === 0) return [];
      const out: StreamEvent[] = [emit(pending)];
      pending = '';
      return out;
    }
  };
};

/**
 * Probe a local OpenAI-compatible endpoint to see if it's reachable.
 * Designed for the auto-detect path: a 200ms timeout against
 * `${baseUrl}/models` (the standard OpenAI listing endpoint, served
 * by Ollama, LM Studio, vLLM, llama.cpp). Returns `true` when the
 * server answers with any 2xx status.
 */
export const probeLocalProvider = async (
  baseUrl: string = DEFAULT_BASE_URL,
  options: { readonly timeoutMs?: number; readonly fetch?: typeof fetch } = {}
): Promise<boolean> => {
  const doFetch = options.fetch ?? fetch;
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), options.timeoutMs ?? 200);
  try {
    const res = await doFetch(url, { method: 'GET', signal: ac.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * List the models a local OpenAI-compatible server exposes via the
 * standard `GET /models` endpoint. Returns `null` when the server
 * isn't reachable or the response isn't well-formed — callers can
 * treat that as "no local models available right now".
 */
export const listLocalModels = async (
  baseUrl: string = DEFAULT_BASE_URL,
  options: { readonly fetch?: typeof fetch; readonly apiKey?: string } = {}
): Promise<readonly string[] | null> => {
  const doFetch = options.fetch ?? fetch;
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.apiKey) headers['authorization'] = `Bearer ${options.apiKey}`;
  try {
    const res = await doFetch(url, { method: 'GET', headers });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: ReadonlyArray<{ id?: string }> };
    if (!json || !Array.isArray(json.data)) return null;
    const ids = json.data
      .map((m) => (typeof m.id === 'string' ? m.id : null))
      .filter((id): id is string => id !== null && id.length > 0);
    return ids;
  } catch {
    return null;
  }
};

/**
 * Minimal SSE parser — same shape as the OpenRouter one. Yields the
 * payload string of each `data:` line, including the literal `[DONE]`
 * sentinel.
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

export const __test__ = { createThinkExtractor };
