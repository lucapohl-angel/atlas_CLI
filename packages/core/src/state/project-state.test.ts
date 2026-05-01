import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findFirstStoryByStatus,
  loadProjectState,
  parseProjectState,
  saveProjectState,
  setEpicStatus,
  setStoryStatus,
  summarizeProjectState,
  upsertEpic,
  upsertStory,
  type ProjectStateFile
} from './project-state.js';

describe('parseProjectState', () => {
  it('treats an empty file as the empty default state', () => {
    const r = parseProjectState('', '/virtual/state.yaml');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ version: 1, epics: [], stories: [] });
  });

  it('parses a full state file', () => {
    const yaml = `version: 1
epics:
  - id: epic-1
    title: Authentication
    status: in-progress
stories:
  - id: 1-1-login
    title: Login form
    status: ready-for-dev
    epicId: epic-1
`;
    const r = parseProjectState(yaml, '/virtual/state.yaml');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.epics).toHaveLength(1);
    expect(r.value.stories[0]?.status).toBe('ready-for-dev');
  });

  it('rejects an invalid status value', () => {
    const yaml = `stories:
  - id: 1-1-x
    title: x
    status: shipped
`;
    const r = parseProjectState(yaml, '/virtual/state.yaml');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('STATE_PARSE_FAILED');
  });

  it('rejects malformed YAML', () => {
    const r = parseProjectState(': : : not yaml', '/virtual/state.yaml');
    expect(r.ok).toBe(false);
  });
});

describe('loadProjectState', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-state-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the empty default when the file does not exist', async () => {
    const r = await loadProjectState({ cwd: dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stories).toEqual([]);
    expect(r.value.epics).toEqual([]);
  });

  it('reads from <cwd>/.atlas/state.yaml when present', async () => {
    const path = join(dir, '.atlas', 'state.yaml');
    await writeFile(path.replace(/state\.yaml$/, ''), '').catch(() => undefined); // noop, dir
    // Use saveProjectState to write a valid file then read back.
    const init: ProjectStateFile = {
      version: 1,
      epics: [],
      stories: [{ id: '1-1-x', title: 'X', status: 'draft' }]
    };
    const save = await saveProjectState(init, { cwd: dir });
    expect(save.ok).toBe(true);
    const load = await loadProjectState({ cwd: dir });
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.value.stories[0]?.id).toBe('1-1-x');
  });
});

describe('saveProjectState', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-state-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates <cwd>/.atlas/state.yaml with parent dir', async () => {
    const r = await saveProjectState(
      { version: 1, epics: [], stories: [] },
      { cwd: dir }
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.path).toBe(join(dir, '.atlas', 'state.yaml'));
    const raw = await readFile(r.value.path, 'utf8');
    expect(raw).toContain('# Atlas project state');
    expect(raw).toContain('version: 1');
  });
});

describe('upsert / status transitions', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-state-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('upsertEpic adds and replaces by id', async () => {
    const a = await upsertEpic({ cwd: dir, epic: { id: 'epic-1', title: 'Auth', status: 'backlog' } });
    expect(a.ok).toBe(true);
    const b = await upsertEpic({
      cwd: dir,
      epic: { id: 'epic-1', title: 'Auth', status: 'in-progress' }
    });
    expect(b.ok).toBe(true);
    const state = await loadProjectState({ cwd: dir });
    if (!state.ok) throw state.error;
    expect(state.value.epics).toHaveLength(1);
    expect(state.value.epics[0]?.status).toBe('in-progress');
    expect(state.value.epics[0]?.lastUpdated).toBeDefined();
  });

  it('upsertStory adds and replaces by id', async () => {
    await upsertStory({
      cwd: dir,
      story: { id: '1-1-login', title: 'Login', status: 'draft' }
    });
    await upsertStory({
      cwd: dir,
      story: { id: '1-1-login', title: 'Login', status: 'ready-for-dev', owner: 'hercules' }
    });
    const state = await loadProjectState({ cwd: dir });
    if (!state.ok) throw state.error;
    expect(state.value.stories).toHaveLength(1);
    expect(state.value.stories[0]?.status).toBe('ready-for-dev');
    expect(state.value.stories[0]?.owner).toBe('hercules');
  });

  it('setStoryStatus transitions a known story', async () => {
    await upsertStory({
      cwd: dir,
      story: { id: '1-1-x', title: 'X', status: 'ready-for-dev' }
    });
    const r = await setStoryStatus({ cwd: dir, storyId: '1-1-x', status: 'in-progress' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('in-progress');
  });

  it('setStoryStatus reports STATE_STORY_NOT_FOUND on unknown id', async () => {
    const r = await setStoryStatus({ cwd: dir, storyId: 'nope', status: 'review' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('STATE_STORY_NOT_FOUND');
  });

  it('setEpicStatus reports STATE_EPIC_NOT_FOUND on unknown id', async () => {
    const r = await setEpicStatus({ cwd: dir, epicId: 'nope', status: 'done' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('STATE_EPIC_NOT_FOUND');
  });
});

describe('queries', () => {
  it('findFirstStoryByStatus returns earliest matching by declaration order', () => {
    const state: ProjectStateFile = {
      version: 1,
      epics: [],
      stories: [
        { id: '1-1-a', title: 'A', status: 'in-progress' },
        { id: '1-2-b', title: 'B', status: 'ready-for-dev' },
        { id: '1-3-c', title: 'C', status: 'ready-for-dev' }
      ]
    };
    expect(findFirstStoryByStatus(state, 'ready-for-dev')?.id).toBe('1-2-b');
    expect(findFirstStoryByStatus(state, 'done')).toBeUndefined();
  });

  it('summarizeProjectState counts by status', () => {
    const state: ProjectStateFile = {
      version: 1,
      epics: [
        { id: 'e1', title: 'E1', status: 'in-progress' },
        { id: 'e2', title: 'E2', status: 'done' }
      ],
      stories: [
        { id: '1-1-a', title: 'A', status: 'done' },
        { id: '1-2-b', title: 'B', status: 'review' },
        { id: '1-3-c', title: 'C', status: 'review' }
      ]
    };
    const s = summarizeProjectState(state);
    expect(s.totalStories).toBe(3);
    expect(s.totalEpics).toBe(2);
    expect(s.stories.review).toBe(2);
    expect(s.stories.done).toBe(1);
    expect(s.epics.done).toBe(1);
  });
});
