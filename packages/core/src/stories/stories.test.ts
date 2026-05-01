import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStory,
  decideSectionAccess,
  loadStory,
  splitSections,
  updateStorySection,
  emitHandoff,
  consumeHandoff,
  listHandoffs,
  type CallingAgent
} from './index.js';

describe('stories', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-stories-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('splitSections', () => {
    it('splits an H2-delimited body and trims content', () => {
      const body = '## A\n\nbody-a\n\n## B\nbody-b\n';
      const out = splitSections(body);
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({ title: 'A', body: 'body-a' });
      expect(out[1]).toEqual({ title: 'B', body: 'body-b' });
    });

    it('discards preamble before the first H2', () => {
      const body = 'preamble line\n\n## Real\n\nx\n';
      const out = splitSections(body);
      expect(out).toEqual([{ title: 'Real', body: 'x' }]);
    });
  });

  describe('createStory + loadStory', () => {
    it('writes a scaffold with default sections and parses back cleanly', async () => {
      const r = await createStory({
        id: 'login-flow',
        title: 'Login flow',
        agent: 'hercules',
        dir,
        now: '2026-05-01T00:00:00.000Z'
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const loaded = await loadStory(r.value.path);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value.frontmatter.id).toBe('login-flow');
      expect(loaded.value.frontmatter.title).toBe('Login flow');
      expect(loaded.value.frontmatter.agent).toBe('hercules');
      expect(loaded.value.frontmatter.status).toBe('draft');
      const titles = loaded.value.sections.map((s) => s.title);
      expect(titles).toContain('Goals');
      expect(titles).toContain('Architecture');
      expect(titles).toContain('Tasks');
      expect(titles).toContain('Change Log');
    });

    it('refuses to overwrite an existing story without force', async () => {
      const a = await createStory({ id: 's', title: 'S', dir });
      expect(a.ok).toBe(true);
      const b = await createStory({ id: 's', title: 'S', dir });
      expect(b.ok).toBe(false);
    });
  });

  describe('decideSectionAccess (mixed-mode authorization)', () => {
    const dev: CallingAgent = {
      name: 'hercules',
      authorizedSections: ['Tasks', 'Implementation Notes'],
      forbiddenSections: ['Goals', 'Architecture']
    };

    it('allows when section is in authorizedSections', () => {
      expect(decideSectionAccess(dev, 'Tasks')).toEqual({ action: 'allow' });
    });

    it('denies when section is in forbiddenSections', () => {
      const d = decideSectionAccess(dev, 'Architecture');
      expect(d.action).toBe('deny');
    });

    it('warns when section is outside authorized but not forbidden', () => {
      const d = decideSectionAccess(dev, 'Test Strategy');
      expect(d.action).toBe('warn');
    });

    it('allows everything when no calling agent is supplied', () => {
      expect(decideSectionAccess(undefined, 'Anything')).toEqual({ action: 'allow' });
    });

    it('allows everything when agent declares no authorizedSections', () => {
      const a: CallingAgent = { name: 'atlas' };
      expect(decideSectionAccess(a, 'Goals')).toEqual({ action: 'allow' });
    });

    it('forbiddenSections beats authorizedSections (defense-in-depth)', () => {
      const a: CallingAgent = {
        name: 'weird',
        authorizedSections: ['Goals'],
        forbiddenSections: ['Goals']
      };
      expect(decideSectionAccess(a, 'Goals').action).toBe('deny');
    });
  });

  describe('updateStorySection', () => {
    let storyPath: string;

    beforeEach(async () => {
      const r = await createStory({
        id: 's1',
        title: 'S1',
        dir,
        now: '2026-05-01T00:00:00.000Z'
      });
      if (!r.ok) throw new Error('setup failed');
      storyPath = r.value.path;
    });

    it('hard-fails on forbiddenSections without writing', async () => {
      const dev: CallingAgent = {
        name: 'hercules',
        authorizedSections: ['Tasks'],
        forbiddenSections: ['Goals']
      };
      const r = await updateStorySection({
        path: storyPath,
        sectionTitle: 'Goals',
        content: 'sneaky edit',
        callingAgent: dev
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('STORY_SECTION_FORBIDDEN');
      const onDisk = await readFile(storyPath, 'utf8');
      expect(onDisk).not.toContain('sneaky edit');
    });

    it('writes silently when the section is in authorizedSections', async () => {
      const dev: CallingAgent = {
        name: 'hercules',
        authorizedSections: ['Tasks'],
        forbiddenSections: ['Goals']
      };
      const r = await updateStorySection({
        path: storyPath,
        sectionTitle: 'Tasks',
        content: '- ship it',
        callingAgent: dev,
        now: '2026-05-02T00:00:00.000Z'
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.warning).toBeUndefined();
      const loaded = await loadStory(storyPath);
      if (!loaded.ok) throw new Error('reload failed');
      const tasks = loaded.value.sections.find((s) => s.title === 'Tasks');
      expect(tasks?.body).toBe('- ship it');
      // Soft-boundary log NOT appended when allowed.
      const changeLog = loaded.value.sections.find((s) => s.title === 'Change Log');
      expect(changeLog?.body ?? '').not.toContain('soft-boundary');
    });

    it('warn+writes for unauthorized-but-not-forbidden, appending to Change Log', async () => {
      const dev: CallingAgent = {
        name: 'hercules',
        authorizedSections: ['Tasks'],
        forbiddenSections: ['Goals']
      };
      const r = await updateStorySection({
        path: storyPath,
        sectionTitle: 'Test Strategy',
        content: 'covered by integration tests',
        callingAgent: dev,
        now: '2026-05-03T00:00:00.000Z'
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.warning).toContain('soft boundary');
      const loaded = await loadStory(storyPath);
      if (!loaded.ok) throw new Error('reload failed');
      const ts = loaded.value.sections.find((s) => s.title === 'Test Strategy');
      expect(ts?.body).toBe('covered by integration tests');
      const cl = loaded.value.sections.find((s) => s.title === 'Change Log');
      expect(cl?.body).toContain('soft-boundary cross');
      expect(cl?.body).toContain('hercules');
      expect(cl?.body).toContain('Test Strategy');
    });

    it('returns STORY_SECTION_MISSING for an unknown section', async () => {
      const r = await updateStorySection({
        path: storyPath,
        sectionTitle: 'Nonexistent',
        content: 'x'
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('STORY_SECTION_MISSING');
    });

    it('updates the updatedAt timestamp on success', async () => {
      const r = await updateStorySection({
        path: storyPath,
        sectionTitle: 'Tasks',
        content: '- one',
        now: '2026-05-09T00:00:00.000Z'
      });
      expect(r.ok).toBe(true);
      const loaded = await loadStory(storyPath);
      if (!loaded.ok) throw new Error('reload failed');
      expect(loaded.value.frontmatter.updatedAt).toBe('2026-05-09T00:00:00.000Z');
      expect(loaded.value.frontmatter.createdAt).toBe('2026-05-01T00:00:00.000Z');
    });
  });

  describe('handoffs', () => {
    it('emits, lists pending, then consumes', async () => {
      const handoffDir = join(dir, '.handoffs');
      await mkdir(handoffDir, { recursive: true });
      const e = await emitHandoff({
        fromAgent: 'athena',
        toAgent: 'prometheus',
        storyId: 'login-flow',
        command: 'write-architecture',
        payload: { note: 'PRD ready for arch' },
        dir: handoffDir,
        now: '2026-05-01T01:02:03.000Z'
      });
      expect(e.ok).toBe(true);
      if (!e.ok) return;
      const list = await listHandoffs({ dir: handoffDir });
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.value).toHaveLength(1);
      expect(list.value[0]?.handoff.toAgent).toBe('prometheus');

      const c = await consumeHandoff(e.value.path);
      expect(c.ok).toBe(true);
      if (!c.ok) return;
      expect(c.value.consumed).toBe(true);
      expect(c.value.payload).toEqual({ note: 'PRD ready for arch' });

      const after = await listHandoffs({ dir: handoffDir });
      if (!after.ok) return;
      expect(after.value).toHaveLength(0);
    });

    it('filters by toAgent', async () => {
      const handoffDir = join(dir, '.handoffs');
      await emitHandoff({ fromAgent: 'a', toAgent: 'b', dir: handoffDir, now: '2026-05-01T00:00:00.000Z' });
      await emitHandoff({ fromAgent: 'a', toAgent: 'c', dir: handoffDir, now: '2026-05-01T00:00:01.000Z' });
      const r = await listHandoffs({ dir: handoffDir, toAgent: 'c' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.handoff.toAgent).toBe('c');
    });
  });
});
