/**
 * Tests for the tool catalog: persistence round-trip + status resolution
 * for registered/disabled/missing tools. Probes that touch Docker or
 * Playwright are mocked.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Re-route HOME via env so loadToolsState's `homedir()` lands inside a
// per-test scratch dir. (Spying on `os.homedir` doesn't work for ESM
// namespace exports.)
const useTmpHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-tools-'));
  process.env.HOME = dir;
  // On some systems Node prefers USERPROFILE; cover both.
  process.env.USERPROFILE = dir;
  return dir;
};

vi.mock('./searxng-manager.js', () => ({
  searxngStatus: vi.fn(async () => ({
    dockerInstalled: true,
    imagePulled: true,
    containerExists: true,
    running: true,
    url: 'http://127.0.0.1:8080'
  })),
  searxngStart: vi.fn(),
  searxngStop: vi.fn(),
  searxngRemove: vi.fn(),
  searxngPullImage: vi.fn()
}));

vi.mock('./browser/session.js', () => ({
  browserAvailable: vi.fn(async () => true),
  closeBrowser: vi.fn()
}));

import {
  loadToolsState,
  saveToolsState,
  setToolEnabled,
  isToolDisabled,
  resolveCatalogStatus,
  toolCatalog
} from './catalog.js';

describe('tool catalog persistence', () => {
  beforeEach(() => {
    useTmpHome();
  });

  it('persists disabled tools across loads', async () => {
    expect((await loadToolsState()).disabled).toEqual([]);
    await saveToolsState({ disabled: ['web_search', 'browser'] });
    const reloaded = await loadToolsState();
    expect(reloaded.disabled).toEqual(['web_search', 'browser']);
  });

  it('setToolEnabled toggles entries', async () => {
    await setToolEnabled('web_search', false);
    expect(await isToolDisabled('web_search')).toBe(true);
    await setToolEnabled('web_search', true);
    expect(await isToolDisabled('web_search')).toBe(false);
  });

  it('saves a sorted disabled list', async () => {
    await setToolEnabled('zeta', false);
    await setToolEnabled('alpha', false);
    const state = await loadToolsState();
    expect(state.disabled).toEqual(['alpha', 'zeta']);
  });
});

describe('resolveCatalogStatus', () => {
  beforeEach(() => {
    useTmpHome();
  });

  it('reports connected for registered tools with passing probes', async () => {
    const registered = new Set(['web_search', 'read_file']);
    const out = await resolveCatalogStatus(registered);
    const ws = out.find((e) => e.entry.name === 'web_search');
    expect(ws?.status.state).toBe('connected');
    const rf = out.find((e) => e.entry.name === 'read_file');
    expect(rf?.status.state).toBe('connected');
  });

  it('reports disconnected for entries missing from the registry', async () => {
    const out = await resolveCatalogStatus(new Set([]));
    const browser = out.find((e) => e.entry.name === 'browser');
    expect(browser?.status.state).toBe('disconnected');
    expect(browser?.registered).toBe(false);
  });

  it('reports disabled when the user disabled the tool', async () => {
    await setToolEnabled('web_search', false);
    const out = await resolveCatalogStatus(new Set(['web_search']));
    const ws = out.find((e) => e.entry.name === 'web_search');
    expect(ws?.status.state).toBe('disabled');
    expect(ws?.disabled).toBe(true);
  });

  it('covers every tool in the catalog', async () => {
    const out = await resolveCatalogStatus(new Set([]));
    expect(out.length).toBe(toolCatalog().length);
    expect(out.every((e) => typeof e.status.detail === 'string')).toBe(true);
  });

  it('marks searxng-backed web_search as essential=false (managed)', () => {
    const ws = toolCatalog().find((e) => e.name === 'web_search');
    expect(ws?.essential).toBe(false);
    expect(ws?.extraActions?.some((a) => a.id === 'install')).toBe(true);
    // Remove must carry a warning so the UI prompts before deleting.
    const remove = ws?.extraActions?.find((a) => a.id === 'remove');
    expect(remove?.warning).toBeTruthy();
  });

  it('marks read_file/write_file/terminal as essential', () => {
    for (const name of ['read_file', 'write_file', 'terminal']) {
      const e = toolCatalog().find((x) => x.name === name);
      expect(e?.essential, name).toBe(true);
    }
  });
});
