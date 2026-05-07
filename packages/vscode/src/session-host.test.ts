import { describe, expect, it } from 'vitest';
import type { Agent } from '@atlas/core/agents';
import { AtlasConfigSchema } from '@atlas/core/config';
import type { CompletionRequest, Provider, StreamEvent } from '@atlas/core/providers';
import { ToolRegistry } from '@atlas/core/tools/registry';
import { createAtlasSessionHost } from './session-host.js';

const agentFixture: Agent = {
  path: 'memory://atlas',
  name: 'atlas',
  role: 'Orchestrator',
  description: 'Routes work.',
  mode: 'build',
  thinkingEffort: 'off',
  skills: [],
  handoffs: [],
  commands: [],
  kind: 'framework',
  systemPrompt: 'You are Atlas.',
};

describe('AtlasSessionHost', () => {
  it('runs a core loop turn and retains non-system history', async () => {
    const seenRequests: CompletionRequest[] = [];
    const provider: Provider = {
      name: 'fake-provider',
      async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
        seenRequests.push(request);
        yield { type: 'delta', text: 'hello' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const config = AtlasConfigSchema.parse({
      defaultModel: 'fake-model',
      providers: { openrouter: { apiKey: 'test-key' } },
    });
    const hostResult = await createAtlasSessionHost({
      cwd: process.cwd(),
      config,
      provider,
      agents: [agentFixture],
      skills: [],
      tools: new ToolRegistry(),
    });

    expect(hostResult.ok).toBe(true);
    if (!hostResult.ok) return;

    const events = [];
    for await (const event of hostResult.value.runTurn('Say hello')) events.push(event);

    expect(events.map((event) => event.type)).toEqual(['delta', 'turn_end', 'done']);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.messages[0]?.role).toBe('system');
    expect(seenRequests[0]?.messages[1]).toEqual({ role: 'user', content: 'Say hello' });
    expect(hostResult.value.history.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('returns a clear error when no agents are available', async () => {
    const provider: Provider = {
      name: 'fake-provider',
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'done', finishReason: 'stop' };
      },
    };

    const hostResult = await createAtlasSessionHost({
      cwd: process.cwd(),
      provider,
      agents: [],
      skills: [],
      tools: new ToolRegistry(),
    });

    expect(hostResult.ok).toBe(false);
    if (hostResult.ok) return;
    expect(hostResult.error.code).toBe('AGENT_NOT_FOUND');
  });
});
