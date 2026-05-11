import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './load.js';

describe('loadConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-cfg-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns defaults when no file and no env', async () => {
    const r = await loadConfig({ path: join(dir, 'missing.yaml'), env: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.defaultProvider).toBe('openrouter');
    expect(r.value.defaultModel).toBe('anthropic/claude-sonnet-4');
    expect(r.value.atlasMode).toBe('full');
    expect(r.value.providers.openrouter.apiKey).toBeUndefined();
    expect(r.value.providers.openrouter.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(r.value.providers.opencode.zen.baseUrl).toBe('https://opencode.ai/zen/v1');
    expect(r.value.providers.opencode.go.baseUrl).toBe('https://opencode.ai/zen/go/v1');
  });

  it('reads YAML file and applies env overrides', async () => {
    const path = join(dir, 'config.yaml');
    await writeFile(
      path,
      'defaultModel: openai/gpt-4o-mini\nproviders:\n  openrouter:\n    apiKey: from-file\n',
      'utf8'
    );
    const r = await loadConfig({
      path,
      env: { OPENROUTER_API_KEY: 'from-env', ATLAS_MODEL: 'anthropic/claude-opus-4' }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.defaultModel).toBe('anthropic/claude-opus-4');
    expect(r.value.providers.openrouter.apiKey).toBe('from-env');
  });

  it('reads OpenCode YAML and applies env overrides', async () => {
    const path = join(dir, 'config.yaml');
    await writeFile(
      path,
      [
        'defaultProvider: opencode-go',
        'providers:',
        '  opencode:',
        '    zen:',
        '      apiKey: zen-file',
        '    go:',
        '      apiKey: go-file'
      ].join('\n'),
      'utf8'
    );
    const r = await loadConfig({
      path,
      env: {
        OPENCODE_ZEN_API_KEY: 'zen-env',
        OPENCODE_ZEN_BASE_URL: 'https://example.test/zen/v1',
        OPENCODE_GO_API_KEY: 'go-env',
        OPENCODE_GO_BASE_URL: 'https://example.test/go/v1'
      }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.defaultProvider).toBe('opencode-go');
    expect(r.value.providers.opencode.zen.apiKey).toBe('zen-env');
    expect(r.value.providers.opencode.zen.baseUrl).toBe('https://example.test/zen/v1');
    expect(r.value.providers.opencode.go.apiKey).toBe('go-env');
    expect(r.value.providers.opencode.go.baseUrl).toBe('https://example.test/go/v1');
  });

  it('accepts ChatGPT / Codex as the default provider', async () => {
    const path = join(dir, 'config.yaml');
    await writeFile(
      path,
      [
        'defaultProvider: openai-codex',
        'defaultModel: gpt-5',
        'providers:',
        '  openai:',
        '    codex:',
        '      accessToken: token'
      ].join('\n'),
      'utf8'
    );
    const r = await loadConfig({ path, env: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.defaultProvider).toBe('openai-codex');
    expect(r.value.defaultModel).toBe('gpt-5');
    expect(r.value.providers.openai.codex.accessToken).toBe('token');
  });

  it('loads direct OpenAI API key settings', async () => {
    const path = join(dir, 'config.yaml');
    await writeFile(
      path,
      [
        'defaultProvider: openai-codex',
        'providers:',
        '  openai:',
        '    authMode: apiKey',
        '    apiKey: from-file',
        '    apiBaseUrl: https://api.openai.com/v1'
      ].join('\n'),
      'utf8'
    );
    const r = await loadConfig({ path, env: { OPENAI_API_KEY: 'from-env' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.providers.openai.authMode).toBe('apiKey');
    expect(r.value.providers.openai.apiKey).toBe('from-env');
    expect(r.value.providers.openai.apiBaseUrl).toBe('https://api.openai.com/v1');
  });

  it('reads hosted Atlas power mode', async () => {
    const path = join(dir, 'config.yaml');
    await writeFile(path, 'atlasMode: smart\n', 'utf8');
    const r = await loadConfig({ path, env: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.atlasMode).toBe('smart');
  });

  it('maps legacy local liteMode to explicit toolMode', async () => {
    const path = join(dir, 'config.yaml');
    await writeFile(
      path,
      'providers:\n  local:\n    liteMode: false\n',
      'utf8'
    );
    const r = await loadConfig({ path, env: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.providers.local.toolMode).toBe('full');
    expect(r.value.providers.local.liteMode).toBe(false);
  });

  it('lets explicit local toolMode override legacy liteMode', async () => {
    const path = join(dir, 'config.yaml');
    await writeFile(
      path,
      'providers:\n  local:\n    toolMode: hybrid\n    liteMode: true\n',
      'utf8'
    );
    const r = await loadConfig({ path, env: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.providers.local.toolMode).toBe('hybrid');
    expect(r.value.providers.local.liteMode).toBe(false);
  });

  it('rejects non-object YAML', async () => {
    const path = join(dir, 'bad.yaml');
    await writeFile(path, '- one\n- two\n', 'utf8');
    const r = await loadConfig({ path, env: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONFIG_INVALID');
  });

  it('rejects schema-invalid values', async () => {
    const path = join(dir, 'bad.yaml');
    await writeFile(path, 'defaultProvider: nope\n', 'utf8');
    const r = await loadConfig({ path, env: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONFIG_INVALID');
  });
});
