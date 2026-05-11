import { describe, expect, it } from 'vitest';
import {
  BridgeAgentSummarySchema,
  BridgeMcpServerSummarySchema,
  BridgeModelSummarySchema,
  BridgeRequestSchema,
  BridgeResponseSchema,
  BridgeStreamEventSchema,
  BridgeSessionSummarySchema,
  BridgeTaskSummarySchema,
  BridgeTodoItemSchema,
  createBridgeErrorResponse,
  createBridgeResponse,
  requestIdFromUnknown,
} from './bridge.js';

describe('VS Code bridge', () => {
  it('accepts a ping request', () => {
    const parsed = BridgeRequestSchema.safeParse({
      requestId: 'req-1',
      kind: 'ping',
      params: {},
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts a status request', () => {
    const parsed = BridgeRequestSchema.safeParse({
      requestId: 'req-status',
      kind: 'getStatus',
      params: {},
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts settings requests', () => {
    expect(BridgeRequestSchema.safeParse({
      requestId: 'req-settings',
      kind: 'getSettings',
      params: {},
    }).success).toBe(true);
    expect(BridgeRequestSchema.safeParse({
      requestId: 'req-open-config',
      kind: 'openConfig',
      params: {},
    }).success).toBe(true);
    expect(BridgeRequestSchema.safeParse({
      requestId: 'req-open-file',
      kind: 'openFile',
      params: { path: 'packages/vscode/src/ui/main.tsx', line: 12 },
    }).success).toBe(true);
  });

  it('accepts VS Code workflow manager requests', () => {
    for (const request of [
      { requestId: 'req-models', kind: 'getModels', params: {} },
      { requestId: 'req-model-select', kind: 'selectModel', params: { id: 'gpt-5', provider: 'openai-codex', thinking: 'high' } },
      { requestId: 'req-agents', kind: 'getAgents', params: {} },
      { requestId: 'req-agent-select', kind: 'selectAgent', params: { name: 'atlas' } },
      { requestId: 'req-mcp', kind: 'getMcpStatus', params: {} },
      { requestId: 'req-sessions', kind: 'getSessions', params: {} },
      { requestId: 'req-resume', kind: 'resumeSession', params: { id: '20260508_120000_abcd12' } },
      { requestId: 'req-new-session', kind: 'newSession', params: {} },
      { requestId: 'req-rename-session', kind: 'renameSession', params: { id: 'session-1', title: 'demo' } },
      { requestId: 'req-delete-session', kind: 'deleteSession', params: { id: 'session-1' } },
      { requestId: 'req-prompt-rename-session', kind: 'promptRenameSession', params: { id: 'session-1', title: 'demo' } },
      { requestId: 'req-task', kind: 'getTaskStatus', params: {} },
      { requestId: 'req-todos', kind: 'getTodos', params: {} },
      { requestId: 'req-approval', kind: 'resolveApproval', params: { approvalId: 'approval-1', action: 'allow' } },
      { requestId: 'req-secret', kind: 'promptSecret', params: { key: 'openrouter.apiKey' } },
      { requestId: 'req-store-secret', kind: 'storeSecret', params: { key: 'openai.apiKey', value: 'sk-test' } },
      { requestId: 'req-clear-secret', kind: 'clearSecret', params: { key: 'openrouter.apiKey' } },
      { requestId: 'req-codex-sign-in', kind: 'signInCodex', params: {} },
      {
        requestId: 'req-update-settings',
        kind: 'updateSettings',
        params: {
          defaultProvider: 'openai-codex',
          defaultModel: 'qwen2.5-coder:7b',
          routerModel: null,
          atlasMode: 'smart',
          vscodePowerMode: 'hybrid',
          anthropicUseClaudeCodeOauth: true,
          openaiAuthMode: 'auto',
          localBaseUrl: 'http://localhost:11434/v1',
          localAutoDetect: true,
          localToolMode: 'hybrid',
          localRequestTimeoutMs: 300000,
          compactionEnabled: true,
          compactionModel: null,
          compactionThreshold: 0.8,
          compactionContextTokens: 200000,
          shipAutoResolve: 'abort',
          promptOnConflict: true,
        },
      },
      { requestId: 'req-enable-mcp', kind: 'setMcpEnabled', params: { name: 'memory', enabled: false } },
      { requestId: 'req-add-mcp', kind: 'addMcpServer', params: { name: 'memory' } },
      { requestId: 'req-upsert-mcp', kind: 'upsertMcpServer', params: { name: 'custom', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], enabled: true } },
      { requestId: 'req-remove-mcp', kind: 'removeMcpServer', params: { name: 'memory' } },
      { requestId: 'req-set-mode', kind: 'setMode', params: { mode: 'plan' } },
      { requestId: 'req-set-thinking', kind: 'setThinking', params: { level: 'high' } },
      { requestId: 'req-cancel', kind: 'cancelTurn', params: {} },
    ] as const) {
      expect(BridgeRequestSchema.safeParse(request).success).toBe(true);
    }
  });

  it('rejects unknown request kinds', () => {
    const parsed = BridgeRequestSchema.safeParse({
      requestId: 'req-1',
      kind: 'readSecrets',
      params: {},
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts provider-shaped stream events', () => {
    const parsed = BridgeStreamEventSchema.safeParse({
      type: 'delta',
      text: 'hello',
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts VS Code host tool result stream events', () => {
    const parsed = BridgeStreamEventSchema.safeParse({
      type: 'tool_result',
      call: { id: 'tool-1', name: 'read_file', arguments: '{"path":"README.md"}' },
      outcome: { type: 'ok', summary: 'read README.md' },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts inline approval stream events', () => {
    expect(BridgeStreamEventSchema.safeParse({
      type: 'approval_request',
      approval: {
        id: 'approval-1',
        tool: 'terminal',
        preview: '{"command":"pnpm test"}',
        createdAt: '2026-05-08T00:00:00.000Z',
      },
    }).success).toBe(true);
    expect(BridgeStreamEventSchema.safeParse({
      type: 'approval_resolved',
      approvalId: 'approval-1',
      action: 'deny',
    }).success).toBe(true);
  });

  it('validates sanitized manager payload rows', () => {
    expect(BridgeModelSummarySchema.safeParse({
      id: 'anthropic/claude-sonnet-4.5',
      label: 'Claude Sonnet 4.5',
      provider: 'openrouter',
      providerLabel: 'OpenRouter',
      contextWindow: 200000,
      promptCache: 'supported',
      promptCacheLabel: 'cache: yes (cheaper)',
      thinking: ['off', 'low', 'medium', 'high'],
      supportsVision: true,
      active: true,
      configuredDefault: true,
      fallback: false,
      custom: false,
      selectable: true,
      note: null,
    }).success).toBe(true);
    expect(BridgeAgentSummarySchema.safeParse({
      name: 'atlas',
      role: 'Orchestrator',
      description: 'Routes work.',
      kind: 'framework',
      active: true,
      switchable: true,
    }).success).toBe(true);
    expect(BridgeMcpServerSummarySchema.safeParse({
      name: 'memory',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      url: null,
      enabled: true,
      configured: true,
      source: 'builtin',
      status: 'not-started',
      tools: 0,
      summary: 'configured',
      docs: null,
      error: null,
    }).success).toBe(true);
    expect(BridgeSessionSummarySchema.safeParse({
      id: 'session-1',
      updatedAt: '2026-05-08T00:00:00.000Z',
      title: null,
      active: false,
    }).success).toBe(true);
    expect(BridgeTaskSummarySchema.safeParse({
      id: 'task-1',
      title: 'Build it',
      phase: 'plan',
      note: null,
      updatedAt: '2026-05-08T00:00:00.000Z',
      contextDocPath: null,
      planDocPath: null,
    }).success).toBe(true);
    expect(BridgeTodoItemSchema.safeParse({
      id: '1',
      content: 'Wire the sidebar',
      status: 'in_progress',
    }).success).toBe(true);
  });

  it('creates typed responses', () => {
    expect(BridgeResponseSchema.safeParse(createBridgeResponse('req-1', { ok: true })).success).toBe(true);
    expect(BridgeResponseSchema.safeParse(createBridgeErrorResponse('req-2', 'Nope', 'NOT_READY')).success).toBe(true);
  });

  it('extracts request ids from unknown messages', () => {
    expect(requestIdFromUnknown({ requestId: 'req-1' })).toBe('req-1');
    expect(requestIdFromUnknown({ requestId: 123 })).toBeUndefined();
    expect(requestIdFromUnknown(null)).toBeUndefined();
  });
});
