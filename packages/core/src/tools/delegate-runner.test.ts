import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Agent } from '../agents/types.js';
import { ok } from '../result.js';
import type { CompletionRequest, Provider, StreamEvent, ToolCall } from '../providers/types.js';
import { createDelegateRunner } from './delegate-runner.js';
import { ToolRegistry } from './registry.js';
import type { ApprovalPolicy, Tool } from './types.js';

const agent: Agent = {
  name: 'atlas',
  role: 'orchestrator',
  description: 'Routes work.',
  mode: 'build',
  thinkingEffort: 'off',
  skills: [],
  handoffs: [],
  commands: [],
  kind: 'framework',
  path: '/tmp/atlas/AGENT.md',
  systemPrompt: 'You are Atlas.'
};

const toolCall = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args)
});

const askModeTool: Tool<{ value: string }> = {
  name: 'mutate',
  description: 'A pretend side-effect tool.',
  approval: 'ask',
  schema: z.object({ value: z.string() }),
  async execute(input) {
    return ok({ type: 'ok', summary: `mutated:${input.value}` });
  }
};

const buildProvider = (requests: CompletionRequest[]): Provider => {
  let turn = 0;
  return {
    name: 'mock',
    async *stream(request): AsyncIterable<StreamEvent> {
      requests.push(request);
      turn += 1;
      if (turn === 1) {
        yield { type: 'tool_call', call: toolCall('call_1', 'mutate', { value: 'ok' }) };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'delta', text: 'child done' };
      yield { type: 'done', finishReason: 'stop' };
    }
  };
};

describe('createDelegateRunner', () => {
  it('uses an inherited approval policy for ask-mode child tools', async () => {
    const requests: CompletionRequest[] = [];
    const tools = new ToolRegistry();
    tools.register(askModeTool);
    const approvals: string[] = [];
    const approve: ApprovalPolicy = {
      decide(tool) {
        approvals.push(tool);
        return { action: 'allow' };
      }
    };
    const runner = createDelegateRunner({
      provider: buildProvider(requests),
      model: 'mock-model',
      agents: new Map([[agent.name, agent]]),
      defaultAgent: agent,
      skills: [],
      baseTools: tools,
      baseToolContext: { cwd: process.cwd() }
    });

    const result = await runner({ goal: 'Use the mutate tool.', approve });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('child done');
    expect(approvals).toEqual(['mutate']);
    expect(requests.length).toBe(2);
    const toolMessage = requests[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe('mutated:ok');
  });
});
