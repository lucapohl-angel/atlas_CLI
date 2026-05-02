import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearActiveTask,
  currentTaskPointerPath,
  loadActiveTask,
  loadCurrentTaskPointer,
  loadTaskState,
  newTaskId,
  saveCurrentTaskPointer,
  saveTaskState,
  startTask,
  taskStatePath,
  titleFromMessage,
  updateTask
} from './state.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'atlas-workflow-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('newTaskId', () => {
  it('produces a stable, sortable id', () => {
    const a = newTaskId(new Date('2026-01-02T03:04:05Z'));
    expect(a).toMatch(/^20260102-030405-[0-9a-f]{4}$/);
  });
});

describe('titleFromMessage', () => {
  it('passes through short messages', () => {
    expect(titleFromMessage('build a CLI')).toBe('build a CLI');
  });

  it('trims long messages on a word boundary', () => {
    const t = titleFromMessage(
      'please build me a really comprehensive command line interface tool that does many things'
    );
    expect(t.length).toBeLessThanOrEqual(61);
    expect(t.endsWith('…')).toBe(true);
  });

  it('collapses whitespace', () => {
    expect(titleFromMessage('hello\n  world')).toBe('hello world');
  });
});

describe('loadCurrentTaskPointer', () => {
  it('returns activeTaskId: null when file is missing', async () => {
    const r = await loadCurrentTaskPointer(cwd);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.activeTaskId).toBeNull();
  });

  it('round-trips', async () => {
    const wrote = await saveCurrentTaskPointer(cwd, { activeTaskId: 'abc' });
    expect(wrote.ok).toBe(true);
    const read = await loadCurrentTaskPointer(cwd);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.activeTaskId).toBe('abc');
  });

  it('reports parse failure on garbage', async () => {
    await saveCurrentTaskPointer(cwd, { activeTaskId: null });
    // Corrupt by writing nonsense to the same path.
    await (await import('node:fs/promises')).writeFile(
      currentTaskPointerPath(cwd),
      '{not json',
      'utf8'
    );
    const r = await loadCurrentTaskPointer(cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('WORKFLOW_STATE_PARSE_FAILED');
  });
});

describe('startTask + loadActiveTask', () => {
  it('creates state file + pointer', async () => {
    const r = await startTask({ cwd, title: 'sample' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.phase).toBe('discover');
    const written = await readFile(taskStatePath(cwd, r.value.id), 'utf8');
    expect(JSON.parse(written).id).toBe(r.value.id);

    const active = await loadActiveTask(cwd);
    expect(active.ok).toBe(true);
    if (active.ok) expect(active.value?.id).toBe(r.value.id);
  });

  it('returns null active task when pointer is null', async () => {
    const r = await loadActiveTask(cwd);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('treats stale pointer as no active task', async () => {
    await saveCurrentTaskPointer(cwd, { activeTaskId: 'never-existed' });
    const r = await loadActiveTask(cwd);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });
});

describe('updateTask', () => {
  it('bumps phase + updatedAt', async () => {
    const created = await startTask({
      cwd,
      title: 't',
      now: new Date('2026-01-01T00:00:00Z')
    });
    if (!created.ok) throw created.error;
    const updated = await updateTask(
      created.value,
      { phase: 'plan', note: '2 questions' },
      new Date('2026-01-02T00:00:00Z')
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.phase).toBe('plan');
    expect(updated.value.note).toBe('2 questions');
    expect(updated.value.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    const reread = await loadTaskState(cwd, created.value.id);
    expect(reread.ok && reread.value?.phase).toBe('plan');
  });
});

describe('clearActiveTask', () => {
  it('nulls the pointer but preserves the state file', async () => {
    const created = await startTask({ cwd, title: 't' });
    if (!created.ok) throw created.error;
    const cleared = await clearActiveTask(cwd);
    expect(cleared.ok).toBe(true);
    const active = await loadActiveTask(cwd);
    expect(active.ok && active.value).toBeNull();
    const stateStill = await loadTaskState(cwd, created.value.id);
    expect(stateStill.ok && stateStill.value?.id).toBe(created.value.id);
  });
});
