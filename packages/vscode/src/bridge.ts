import type { StreamEvent } from '@atlas/core';
import { z } from 'zod';

const RequestIdSchema = z.string().min(1);

const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
}).strict();

const TokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
}).strict();

const ErrorLikeSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
}).passthrough();

export const BridgeStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('delta'),
    text: z.string(),
  }).strict(),
  z.object({
    type: z.literal('thinking'),
    text: z.string(),
  }).strict(),
  z.object({
    type: z.literal('tool_call_delta'),
    index: z.number().int().nonnegative(),
    id: z.string().optional(),
    name: z.string().optional(),
    argumentsDelta: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal('tool_call'),
    call: ToolCallSchema,
  }).strict(),
  z.object({
    type: z.literal('done'),
    finishReason: z.string().nullable(),
    usage: TokenUsageSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('error'),
    error: ErrorLikeSchema,
  }).strict(),
]);

export type BridgeStreamEvent = z.infer<typeof BridgeStreamEventSchema>;
export type CoreStreamEvent = StreamEvent;

export const BridgeRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('ping'),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('runTurn'),
    params: z.object({
      prompt: z.string().min(1),
    }).strict(),
  }).strict(),
]);

export const BridgeResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('response'),
    result: z.unknown(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('stream-event'),
    event: BridgeStreamEventSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('error'),
    error: z.object({
      message: z.string(),
      code: z.string().optional(),
    }).strict(),
  }).strict(),
]);

export type BridgeRequest = z.infer<typeof BridgeRequestSchema>;
export type BridgeResponse = z.infer<typeof BridgeResponseSchema>;

export function createBridgeResponse(requestId: string, result: unknown): BridgeResponse {
  return {
    requestId,
    kind: 'response',
    result,
  };
}

export function createBridgeErrorResponse(
  requestId: string,
  message: string,
  code?: string,
): BridgeResponse {
  return {
    requestId,
    kind: 'error',
    error: code === undefined ? { message } : { message, code },
  };
}

export function requestIdFromUnknown(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const requestId = (input as { readonly requestId?: unknown }).requestId;
  return typeof requestId === 'string' && requestId.length > 0 ? requestId : undefined;
}
