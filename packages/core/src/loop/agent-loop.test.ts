import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgentLoop, type LoopEvent } from './agent-loop.js';
import { atlasError } from '../errors.js';
import { ok } from '../result.js';
import { ToolRegistry, allowAllPolicy, type Tool } from '../tools/index.js';
import type { Provider, StreamEvent, ToolCall } from '../providers/types.js';

const collect = async (
  it: AsyncIterable<LoopEvent>
): Promise<readonly LoopEvent[]> => {
  const out: LoopEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

const echoTool: Tool<{ value: string }> = {
  name: 'echo',
  description: 'Echo a string back.',
  approval: 'auto',
  schema: z.object({ value: z.string() }),
  async execute(input) {
    return ok({ type: 'ok', summary: `echo:${input.value}` });
  }
};

const buildProvider = (
  scripts: ReadonlyArray<readonly StreamEvent[]>
): Provider => {
  let turn = 0;
  return {
    name: 'mock',
    async *stream(): AsyncIterable<StreamEvent> {
      const script = scripts[turn] ?? [];
      turn += 1;
      for (const e of script) yield e;
    }
  };
};

const tc = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args)
});

describe('agent loop', () => {
  it('completes a single turn with no tool calls', async () => {
    const provider = buildProvider([
      [
        { type: 'delta', text: 'Hello' },
        { type: 'delta', text: ', world' },
        { type: 'done', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } }
      ]
    ]);
    const tools = new ToolRegistry();
    const events = await collect(
      runAgentLoop({
        provider,
        model: 'm',
        tools,
        toolContext: { cwd: '/', approve: allowAllPolicy },
        initialMessages: [{ role: 'user', content: 'hi' }]
      })
    );
    const text = events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
    expect(text).toBe('Hello, world');
    const last = events.at(-1);
    expect(last?.type).toBe('done');
    if (last?.type === 'done') {
      expect(last.rounds).toBe(1);
      expect(last.messages.at(-1)?.role).toBe('assistant');
    }
  });

  it('executes a tool call and feeds the result back into a second turn', async () => {
    const provider = buildProvider([
      [
        { type: 'tool_call', call: tc('call_1', 'echo', { value: 'ping' }) },
        { type: 'done', finishReason: 'tool_calls' }
      ],
      [
        { type: 'delta', text: 'got: ' },
        { type: 'delta', text: 'echo:ping' },
        { type: 'done', finishReason: 'stop' }
      ]
    ]);
    const tools = new ToolRegistry();
    tools.register(echoTool);
    const events = await collect(
      runAgentLoop({
        provider,
        model: 'm',
        tools,
        toolContext: { cwd: '/', approve: allowAllPolicy },
        initialMessages: [{ role: 'user', content: 'ping it' }]
      })
    );
    const startedCalls = events.flatMap((e) =>
      e.type === 'tool_call_start' ? [e.call.name] : []
    );
    expect(startedCalls).toEqual(['echo']);
    const doneEvents = events.flatMap((e) =>
      e.type === 'tool_call_done' ? [e.outcome] : []
    );
    expect(doneEvents[0]?.type).toBe('ok');
    const text = events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
    expect(text).toBe('got: echo:ping');
    const last = events.at(-1);
    if (last?.type === 'done') {
      expect(last.rounds).toBe(2);
      // user, assistant(tool_calls), tool, assistant(text)
      expect(last.messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'assistant'
      ]);
    } else {
      throw new Error('expected done');
    }
  });

  it('reports invalid JSON tool arguments as a tool error and continues', async () => {
    const badCall: ToolCall = { id: 'c', name: 'echo', arguments: '{not json' };
    const provider = buildProvider([
      [
        { type: 'tool_call', call: badCall },
        { type: 'done', finishReason: 'tool_calls' }
      ],
      [
        { type: 'delta', text: 'sorry' },
        { type: 'done', finishReason: 'stop' }
      ]
    ]);
    const tools = new ToolRegistry();
    tools.register(echoTool);
    const events = await collect(
      runAgentLoop({
        provider,
        model: 'm',
        tools,
        toolContext: { cwd: '/', approve: allowAllPolicy },
        initialMessages: [{ role: 'user', content: 'go' }]
      })
    );
    const failure = events.find((e) => e.type === 'tool_call_done');
    expect(failure?.type).toBe('tool_call_done');
    if (failure?.type === 'tool_call_done') {
      expect(failure.outcome.type).toBe('error');
      if (failure.outcome.type === 'error') {
        expect(failure.outcome.error.code).toBe('TOOL_INPUT_INVALID');
      }
    }
  });

  it('propagates provider errors as a loop error event', async () => {
    const provider = buildProvider([
      [{ type: 'error', error: atlasError('PROVIDER_NETWORK', 'boom') }]
    ]);
    const events = await collect(
      runAgentLoop({
        provider,
        model: 'm',
        tools: new ToolRegistry(),
        toolContext: { cwd: '/', approve: allowAllPolicy },
        initialMessages: [{ role: 'user', content: 'hi' }]
      })
    );
    const last = events.at(-1);
    expect(last?.type).toBe('error');
    if (last?.type === 'error') expect(last.error.code).toBe('PROVIDER_NETWORK');
  });

  it('honors maxRounds as a hard cap', async () => {
    const provider: Provider = {
      name: 'mock',
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'tool_call', call: tc('x', 'echo', { value: 'a' }) };
        yield { type: 'done', finishReason: 'tool_calls' };
      }
    };
    const tools = new ToolRegistry();
    tools.register(echoTool);
    const events = await collect(
      runAgentLoop({
        provider,
        model: 'm',
        tools,
        toolContext: { cwd: '/', approve: allowAllPolicy },
        initialMessages: [{ role: 'user', content: 'loop' }],
        maxRounds: 3
      })
    );
    const last = events.at(-1);
    expect(last?.type).toBe('error');
    if (last?.type === 'error') expect(last.error.code).toBe('INTERNAL');
  });

  it('cancels via AbortSignal between turns', async () => {
    const ac = new AbortController();
    const provider: Provider = {
      name: 'mock',
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'tool_call', call: tc('x', 'echo', { value: 'a' }) };
        yield { type: 'done', finishReason: 'tool_calls' };
        ac.abort();
      }
    };
    const tools = new ToolRegistry();
    tools.register(echoTool);
    const events = await collect(
      runAgentLoop({
        provider,
        model: 'm',
        tools,
        toolContext: { cwd: '/', approve: allowAllPolicy },
        initialMessages: [{ role: 'user', content: 'go' }],
        signal: ac.signal
      })
    );
    const last = events.at(-1);
    expect(last?.type).toBe('error');
    if (last?.type === 'error') expect(last.error.code).toBe('CANCELLED');
  });
});
