import type { StreamEvent } from '@atlas/core';
import { z } from 'zod';

const RequestIdSchema = z.string().min(1);
const ThinkingLevelSchema = z.enum(['off', 'low', 'medium', 'high', 'xhigh']);
const ModelProviderKindSchema = z.enum([
  'openrouter',
  'anthropic',
  'openai-codex',
  'local',
  'opencode-zen',
  'opencode-go',
]);
const DefaultProviderSchema = z.enum(['openrouter', 'anthropic', 'openai-codex', 'local', 'opencode-zen', 'opencode-go']);
const ShipAutoResolveSchema = z.enum(['abort', 'ours', 'theirs', 'ai']);
const McpServerUpdateSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'http']),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  enabled: z.boolean(),
}).strict();

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

const ToolOutcomeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ok'),
    summary: z.string(),
  }).strict(),
  z.object({
    type: z.literal('error'),
    error: ErrorLikeSchema,
  }).strict(),
]);

const ApprovalActionSchema = z.enum(['allow', 'deny']);
const PromptSecretKeySchema = z.enum([
  'openrouter.apiKey',
  'anthropic.apiKey',
  'openai.apiKey',
  'opencode.zen.apiKey',
  'opencode.go.apiKey',
  'local.apiKey',
  'github.token',
]);

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
    type: z.literal('tool_result'),
    call: ToolCallSchema,
    outcome: ToolOutcomeSchema,
  }).strict(),
  z.object({
    type: z.literal('turn_end'),
  }).strict(),
  z.object({
    type: z.literal('approval_request'),
    approval: z.object({
      id: z.string().min(1),
      tool: z.string().min(1),
      preview: z.string(),
      createdAt: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('approval_resolved'),
    approvalId: z.string().min(1),
    action: ApprovalActionSchema,
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
  z.object({
    type: z.literal('clarify_request'),
    clarify: z.object({
      id: z.string().min(1),
      question: z.string().min(1),
      choices: z.array(z.string()).optional(),
      allowFreeform: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('clarify_resolved'),
    clarifyId: z.string().min(1),
    answer: z.string(),
  }).strict(),
  z.object({
    type: z.literal('learn_reflecting'),
    reason: z.string(),
  }).strict(),
  z.object({
    type: z.literal('learn_review'),
    draft: z.object({
      name: z.string(),
      description: z.string(),
      triggers: z.array(z.string()),
      body: z.string(),
    }).strict(),
    reason: z.string(),
  }).strict(),
  z.object({
    type: z.literal('learn_nothing'),
    reason: z.string(),
    force: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('learn_error'),
    error: z.string(),
  }).strict(),
  z.object({
    type: z.literal('learn_saved'),
    name: z.string(),
    description: z.string(),
  }).strict(),
]);

export type BridgeStreamEvent = z.infer<typeof BridgeStreamEventSchema>;
export type CoreStreamEvent = StreamEvent;

export const BridgeModelSummarySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  provider: ModelProviderKindSchema,
  providerLabel: z.string().min(1),
  contextWindow: z.number().int().positive().nullable(),
  promptCache: z.enum(['supported', 'unsupported', 'unknown']),
  promptCacheLabel: z.string().min(1),
  thinking: z.array(ThinkingLevelSchema).min(1),
  supportsVision: z.boolean(),
  active: z.boolean(),
  configuredDefault: z.boolean(),
  fallback: z.boolean(),
  custom: z.boolean(),
  selectable: z.boolean(),
  note: z.string().nullable(),
}).strict();

export const BridgeAgentSummarySchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  description: z.string().min(1),
  kind: z.enum(['framework', 'user']),
  active: z.boolean(),
  switchable: z.boolean(),
}).strict();

export const BridgeMcpServerSummarySchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'http']),
  enabled: z.boolean(),
  configured: z.boolean(),
  source: z.enum(['configured', 'catalog', 'builtin']),
  status: z.enum(['running', 'disabled', 'not-configured', 'not-started', 'failed']),
  tools: z.number().int().nonnegative(),
  summary: z.string(),
  command: z.string().nullable(),
  args: z.array(z.string()),
  url: z.string().nullable(),
  docs: z.string().nullable(),
  error: z.string().nullable(),
}).strict();

export const BridgeSessionSummarySchema = z.object({
  id: z.string().min(1),
  updatedAt: z.string().min(1),
  title: z.string().nullable(),
  active: z.boolean(),
}).strict();

export const BridgeTaskSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  phase: z.enum(['idle', 'discover', 'plan', 'execute', 'verify', 'ship']),
  note: z.string().nullable(),
  updatedAt: z.string().min(1),
  contextDocPath: z.string().nullable(),
  planDocPath: z.string().nullable(),
}).strict();

export const BridgeTodoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
}).strict();

export const BridgeRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('ping'),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('getStatus'),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('getSettings'),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('openConfig'),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('openFile'),
    params: z.object({
      path: z.string().min(1),
      line: z.number().int().positive().optional(),
      column: z.number().int().positive().optional(),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('getModels'),
    params: z.object({
      forceRefresh: z.boolean().optional(),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('selectModel'),
    params: z.object({
      id: z.string().min(1),
      provider: ModelProviderKindSchema,
      thinking: ThinkingLevelSchema.optional(),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('getAgents'),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('selectAgent'),
    params: z.object({
      name: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('getMcpStatus'),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('getSessions'),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('resumeSession'),
    params: z.object({
      id: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('newSession'),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('renameSession'),
    params: z.object({
      id: z.string().min(1),
      title: z.string(),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('deleteSession'),
    params: z.object({
      id: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('promptRenameSession'),
    params: z.object({
      id: z.string().min(1),
      title: z.string().nullable().optional(),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('getTaskStatus'),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('resolveApproval'),
    params: z.object({
      approvalId: z.string().min(1),
      action: ApprovalActionSchema,
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('promptSecret'),
    params: z.object({
      key: PromptSecretKeySchema,
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('clearSecret'),
    params: z.object({
      key: PromptSecretKeySchema,
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('storeSecret'),
    params: z.object({
      key: PromptSecretKeySchema,
      value: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('signInCodex'),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('updateSettings'),
    params: z.object({
      defaultProvider: DefaultProviderSchema.optional(),
      defaultModel: z.string().min(1).optional(),
      routerModel: z.string().min(1).nullable().optional(),
      atlasMode: z.enum(['full', 'smart']).optional(),
      vscodePowerMode: z.enum(['lite', 'hybrid', 'full']).optional(),
      localBaseUrl: z.string().url().optional(),
      localAutoDetect: z.boolean().optional(),
      localToolMode: z.enum(['lite', 'hybrid', 'full']).optional(),
      localRequestTimeoutMs: z.number().int().positive().optional(),
      anthropicUseClaudeCodeOauth: z.boolean().optional(),
      openaiAuthMode: z.enum(['auto', 'apiKey', 'oauth']).optional(),
      compactionEnabled: z.boolean().optional(),
      compactionModel: z.string().min(1).nullable().optional(),
      compactionThreshold: z.number().gt(0).lte(1).optional(),
      compactionContextTokens: z.number().int().positive().optional(),
      shipAutoResolve: ShipAutoResolveSchema.optional(),
      promptOnConflict: z.boolean().optional(),
      guardrailsEnabled: z.boolean().optional(),
      guardrailDangerousCommand: z.boolean().optional(),
      guardrailPathSafety: z.boolean().optional(),
      guardrailSecretRedaction: z.boolean().optional(),
      guardrailPromptInjectionDetector: z.boolean().optional(),
      guardrailDiscoverGuardrails: z.boolean().optional(),
      guardrailProgressTracker: z.boolean().optional(),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('setMcpEnabled'),
    params: z.object({
      name: z.string().min(1),
      enabled: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('addMcpServer'),
    params: z.object({
      name: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('upsertMcpServer'),
    params: McpServerUpdateSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('removeMcpServer'),
    params: z.object({
      name: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('getTodos'),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('setMode'),
    params: z.object({
      mode: z.enum(['plan', 'build', 'autopilot']),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('setThinking'),
    params: z.object({
      level: ThinkingLevelSchema,
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('cancelTurn'),
    params: z.object({}).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('runTurn'),
    params: z.object({
      prompt: z.string().min(1),
      attachments: z.array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('file'), path: z.string().min(1), content: z.string() }).strict(),
          z.object({ type: z.literal('image'), path: z.string().min(1), base64: z.string().min(1), mediaType: z.string().min(1) }).strict(),
        ])
      ).optional(),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('attachFile'),
    params: z.object({
      type: z.enum(['file', 'image']),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('resolveClarify'),
    params: z.object({
      clarifyId: z.string().min(1),
      answer: z.string(),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('resolveLearn'),
    params: z.object({
      action: z.enum(['save', 'edit', 'discard']),
      changeRequest: z.string().optional(),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('runLearnReflection'),
    params: z.object({
      force: z.boolean().optional(),
    }).strict(),
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    kind: z.literal('setLearnEnabled'),
    params: z.object({
      enabled: z.boolean(),
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
