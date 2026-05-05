import { describe, expect, it } from 'vitest';
import {
  chooseStartupModel,
  providerForStartupModel,
  type StartupModelSelectionInput
} from './runTui.js';
import type {
  CompletionRequest,
  ModelInfo,
  Provider,
  StreamEvent
} from '@atlas/core';

const provider = (name: string): Provider => ({
  name,
  // eslint-disable-next-line require-yield
  async *stream(_req: CompletionRequest): AsyncGenerator<StreamEvent> {
    yield { type: 'done', finishReason: 'stop' };
  }
});

const model = (id: string, kind: ModelInfo['provider']): ModelInfo => ({
  id,
  label: id,
  thinking: ['off'],
  provider: kind
});

const baseInput = (): StartupModelSelectionInput => ({
  configuredModel: 'claude-sonnet-4-5',
  providers: { openrouter: provider('openrouter') },
  fallbackPool: ['anthropic/claude-sonnet-4-5'],
  modelCatalog: [
    model('claude-sonnet-4-5', 'anthropic'),
    model('openai/gpt-5', 'openrouter')
  ]
});

describe('startup model selection', () => {
  it('honors an explicit CLI model first', () => {
    expect(
      chooseStartupModel({
        ...baseInput(),
        explicitModel: 'anthropic/claude-opus-4.7'
      })
    ).toBe('anthropic/claude-opus-4.7');
  });

  it('restores the latest session model when its provider is connected', () => {
    expect(
      chooseStartupModel({
        ...baseInput(),
        resumedModel: 'openai/gpt-5'
      })
    ).toBe('openai/gpt-5');
  });

  it('skips disconnected resumed and configured models', () => {
    expect(
      chooseStartupModel({
        ...baseInput(),
        resumedModel: 'claude-sonnet-4-5'
      })
    ).toBe('openai/gpt-5');
  });

  it('returns the runtime provider that matches the selected model', () => {
    const runtime = provider('openrouter');
    expect(
      providerForStartupModel('openai/gpt-5', baseInput().modelCatalog, {
        openrouter: runtime
      })
    ).toBe(runtime);
  });
});
