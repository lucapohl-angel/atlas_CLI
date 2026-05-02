import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendDiscoverWarning,
  consumeDiscoverWarnings
} from './discover-warnings.js';
import { startTask } from './state.js';
import type { TaskState } from './types.js';

describe('workflow/discover-warnings', () => {
  let cwd: string;
  let state: TaskState;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'atlas-warn-'));
    const r = await startTask({ cwd, title: 'demo' });
    if (!r.ok) throw new Error('startTask');
    state = r.value;
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('consume returns empty array when no warnings written', async () => {
    const w = await consumeDiscoverWarnings(state);
    expect(w).toEqual([]);
  });

  it('appends, consumes, then file is gone', async () => {
    await appendDiscoverWarning(state, 'one focused question per turn');
    await appendDiscoverWarning(state, 'use clarify when vague');
    const w = await consumeDiscoverWarnings(state);
    expect(w).toEqual([
      'one focused question per turn',
      'use clarify when vague'
    ]);
    const w2 = await consumeDiscoverWarnings(state);
    expect(w2).toEqual([]);
  });

  it('dedupes consecutive identical warnings', async () => {
    await appendDiscoverWarning(state, 'same');
    await appendDiscoverWarning(state, 'same');
    await appendDiscoverWarning(state, 'different');
    await appendDiscoverWarning(state, 'same');
    const w = await consumeDiscoverWarnings(state);
    expect(w).toEqual(['same', 'different', 'same']);
  });

  it('rejects empty input silently', async () => {
    const r = await appendDiscoverWarning(state, '   ');
    expect(r.ok).toBe(true);
    const w = await consumeDiscoverWarnings(state);
    expect(w).toEqual([]);
  });

  it('warnings file lives inside the task dir', async () => {
    await appendDiscoverWarning(state, 'hello');
    const path = join(cwd, '.atlas', 'tasks', state.id, '.discover-warnings.txt');
    const body = await readFile(path, 'utf8');
    expect(body).toContain('hello');
  });
});
