import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadClaudeCodeCredentials } from './claude-code.js';

describe('loadClaudeCodeCredentials', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-cc-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns PROVIDER_AUTH_FAILED when the file is missing', async () => {
    const r = await loadClaudeCodeCredentials({ path: join(dir, 'missing.json') });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('PROVIDER_AUTH_FAILED');
  });

  it('parses a well-formed credentials file', async () => {
    const path = join(dir, '.credentials.json');
    await writeFile(
      path,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-fake',
          refreshToken: 'sk-ant-ort01-fake',
          expiresAt: Date.now() + 60_000,
          scopes: ['user:inference'],
          subscriptionType: 'max'
        }
      }),
      'utf8'
    );
    const r = await loadClaudeCodeCredentials({ path });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.accessToken).toBe('sk-ant-oat01-fake');
    expect(r.value.subscriptionType).toBe('max');
    expect(r.value.path).toBe(path);
  });

  it('still returns the token even when expiresAt is in the past (clock skew tolerance)', async () => {
    const path = join(dir, '.credentials.json');
    await writeFile(
      path,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-fake',
          expiresAt: Date.now() - 1000
        }
      }),
      'utf8'
    );
    const r = await loadClaudeCodeCredentials({ path });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.accessToken).toBe('sk-ant-oat01-fake');
  });

  it('rejects malformed JSON', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, '{not json', 'utf8');
    const r = await loadClaudeCodeCredentials({ path });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('PROVIDER_AUTH_FAILED');
  });

  it('rejects an unrecognized credential shape', async () => {
    const path = join(dir, 'wrong.json');
    await writeFile(path, JSON.stringify({ otherShape: true }), 'utf8');
    const r = await loadClaudeCodeCredentials({ path });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('PROVIDER_AUTH_FAILED');
  });

  // Helper kept so future cases can scaffold dirs
  void mkdir;
});
