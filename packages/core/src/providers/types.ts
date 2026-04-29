/**
 * Provider abstraction — every model backend (OpenRouter, Anthropic,
 * OpenAI, Ollama) implements this single interface so the rest of Atlas
 * never branches on vendor.
 *
 * `stream` returns an async iterable of `StreamEvent`s. Cancellation is
 * mandatory: every implementation must honor `request.signal`.
 */
import type { AtlasError } from '../errors.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/**
 * A single tool invocation requested by the model. The `arguments`
 * field is the raw JSON string the model emitted; callers parse + validate
 * before executing.
 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/**
 * Conversation message. Backward compatible with the original two-field
 * shape; the optional fields support the tool-use loop:
 *   - `assistant` messages carry `toolCalls` when the model invoked tools.
 *   - `tool` messages carry the `toolCallId` they reply to.
 */
export interface Message {
  readonly role: Role;
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly name?: string;
}

/**
 * Tool advertised to the model in OpenAI/OpenRouter `tools` format.
 * `parameters` is a JSON Schema object describing the input.
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ReasoningOptions {
  readonly effort: ReasoningEffort;
  /** Optional explicit token budget for thinking (Anthropic-style). */
  readonly maxTokens?: number;
}

export type ToolChoice = 'auto' | 'none' | 'required';

export interface CompletionRequest {
  readonly model: string;
  /**
   * Optional fallback models tried left-to-right if the primary returns a
   * 429 / 503 / network failure. Forwarded to OpenRouter as `models[]`.
   */
  readonly fallbackModels?: readonly string[];
  readonly messages: readonly Message[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly tools?: readonly ToolSpec[];
  readonly toolChoice?: ToolChoice;
  readonly reasoning?: ReasoningOptions;
  readonly signal?: AbortSignal;
}

/**
 * Streaming event union.
 *
 * - `delta`           : assistant text token(s).
 * - `thinking`        : reasoning/thinking token(s) (only for reasoning models).
 * - `tool_call_delta` : partial tool-call assembly (live UI indicator).
 * - `tool_call`       : a fully assembled tool call (consumed by the agent loop).
 * - `done`            : terminal event with finish_reason + usage.
 * - `error`           : terminal event with a typed AtlasError.
 */
export type StreamEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | {
      readonly type: 'tool_call_delta';
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta?: string;
    }
  | { readonly type: 'tool_call'; readonly call: ToolCall }
  | {
      readonly type: 'done';
      readonly finishReason: string | null;
      readonly usage?: TokenUsage;
    }
  | { readonly type: 'error'; readonly error: AtlasError };

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** Reasoning tokens consumed (when the model exposes them). */
  readonly reasoningTokens?: number;
}

export interface Provider {
  readonly name: string;
  stream(request: CompletionRequest): AsyncIterable<StreamEvent>;
}
