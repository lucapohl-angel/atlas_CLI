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
    expect(r.value.providers.openrouter.apiKey).toBeUndefined();
    expect(r.value.providers.openrouter.baseUrl).toBe('https://openrouter.ai/api/v1');
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
