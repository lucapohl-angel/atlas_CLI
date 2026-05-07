import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ATLAS_UPDATE_COMMAND,
  checkForAtlasUpdate,
  dismissAtlasUpdateNotice,
  isNewerVersion,
  type FetchLatestPackage
} from './update-notice.js';

const tempDirs: string[] = [];

const tempStatePath = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-update-notice-'));
  tempDirs.push(dir);
  return join(dir, 'state.json');
};

const latest = (version: string): FetchLatestPackage => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ version })
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('version comparison', () => {
  it('detects semver upgrades', () => {
    expect(isNewerVersion('1.7.3', '1.7.2')).toBe(true);
    expect(isNewerVersion('1.7.2', '1.7.2')).toBe(false);
    expect(isNewerVersion('1.7.1', '1.7.2')).toBe(false);
    expect(isNewerVersion('not-a-version', '1.7.2')).toBe(false);
  });
});

describe('update notice', () => {
  it('returns a notice when npm has a newer atlas-os version', async () => {
    const statePath = await tempStatePath();
    const result = await checkForAtlasUpdate({
      currentVersion: '1.7.2',
      statePath,
      fetchLatestPackage: latest('1.7.3')
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      packageName: 'atlas-os',
      currentVersion: '1.7.2',
      latestVersion: '1.7.3',
      updateCommand: ATLAS_UPDATE_COMMAND
    });
  });

  it('returns null when the installed version is current', async () => {
    const statePath = await tempStatePath();
    const result = await checkForAtlasUpdate({
      currentVersion: '1.7.3',
      statePath,
      fetchLatestPackage: latest('1.7.3')
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('suppresses a dismissed latest version', async () => {
    const statePath = await tempStatePath();
    const dismissed = await dismissAtlasUpdateNotice('1.7.3', { statePath });
    expect(dismissed.ok).toBe(true);

    const result = await checkForAtlasUpdate({
      currentVersion: '1.7.2',
      statePath,
      fetchLatestPackage: latest('1.7.3')
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('reports invalid registry metadata as a recoverable error', async () => {
    const statePath = await tempStatePath();
    const invalid: FetchLatestPackage = async () => ({
      ok: true,
      status: 200,
      json: async () => ({})
    });

    const result = await checkForAtlasUpdate({
      currentVersion: '1.7.2',
      statePath,
      fetchLatestPackage: invalid
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PROVIDER_INVALID_RESPONSE');
  });
});