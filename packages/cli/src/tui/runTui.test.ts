import { describe, expect, it } from 'vitest';
import {
  buildAllProviders,
  chooseStartupModel,
  providerForStartupModel,
  shouldLoadStartupSession,
  type StartupModelSelectionInput
} from './runTui.js';
import type {
  AtlasConfig,
  CompletionRequest,
  ModelInfo,
  Provider,
  StreamEvent
} from '@atlas/core';
import { AtlasConfigSchema as ConfigSchema } from '@atlas/core';

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
  promptCache: kind === 'local' ? 'unsupported' : 'supported',
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

describe('startup session selection', () => {
  it('starts fresh unless the user explicitly asks to resume', () => {
    expect(shouldLoadStartupSession(undefined)).toBe(false);
    expect(shouldLoadStartupSession('latest')).toBe(true);
    expect(shouldLoadStartupSession('session_123')).toBe(true);
  });
});

describe('runtime provider construction', () => {
  it('preserves local lite mode on the picker provider map', async () => {
    const cfg = ConfigSchema.parse({
      defaultProvider: 'local',
      defaultModel: 'qwen2.5-coder:1.5b',
      providers: {
        local: {
          baseUrl: 'http://localhost:11434/v1',
          liteMode: true,
          requestTimeoutMs: 300_000
        }
      }
    }) satisfies AtlasConfig;

    const providers = await buildAllProviders(cfg);

    expect(providers.local?.supportsToolCalling).toBe(false);
  });

  it('preserves local hybrid mode on the picker provider map', async () => {
    const cfg = ConfigSchema.parse({
      defaultProvider: 'local',
      defaultModel: 'qwen2.5-coder:7b',
      providers: {
        local: {
          baseUrl: 'http://localhost:11434/v1',
          toolMode: 'hybrid',
          requestTimeoutMs: 300_000
        }
      }
    }) satisfies AtlasConfig;

    const providers = await buildAllProviders(cfg);

    expect(providers.local?.supportsToolCalling).toBe(true);
    expect(providers.local?.allowedToolNames).toContain('read_file');
    expect(providers.local?.allowedToolNames).not.toContain('browser');
  });
});
