import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SkillRegistry,
  loadSkills,
  renderSkillIndex,
  saveLearnedSkill,
  setSkillDisabled,
  slugifySkillName
} from './loader.js';

describe('skills', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-skills-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty list when dir does not exist', async () => {
    const r = await loadSkills({ dir: join(dir, 'missing') });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('parses SKILL.md frontmatter + body', async () => {
    await mkdir(join(dir, 'tailwind'));
    await writeFile(
      join(dir, 'tailwind', 'SKILL.md'),
      '---\nname: tailwind\ndescription: Tailwind helper\ntriggers: ["tailwind", "css"]\n---\n# body\nUse `bg-foo`.\n',
      'utf8'
    );
    const r = await loadSkills({ dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    const s = r.value[0]!;
    expect(s.name).toBe('tailwind');
    expect(s.triggers).toEqual(['tailwind', 'css']);
    expect(s.body).toContain('# body');
  });

  it('skips skills with invalid frontmatter', async () => {
    await mkdir(join(dir, 'bad'));
    await writeFile(join(dir, 'bad', 'SKILL.md'), '---\ndescription: missing name\n---\nbody\n', 'utf8');
    const r = await loadSkills({ dir });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('SkillRegistry.match finds skills by trigger substrings', () => {
    const reg = new SkillRegistry([
      { name: 'tailwind', description: 'd', triggers: ['css'], path: '/x', body: '' },
      { name: 'react', description: 'd', triggers: ['jsx'], path: '/y', body: '' }
    ]);
    const m = reg.match('I need help with CSS variables');
    expect(m.map((s) => s.name)).toEqual(['tailwind']);
  });

  it('renderSkillIndex produces a stable list', () => {
    const out = renderSkillIndex([
      { name: 'a', description: 'one', triggers: [], kind: 'user', path: '/', body: '' },
      { name: 'b', description: 'two', triggers: [], kind: 'user', path: '/', body: '' }
    ]);
    expect(out).toBe('- a: one\n- b: two');
  });

  it('slugifySkillName produces clean slugs', () => {
    expect(slugifySkillName('Vitest config debug!!!')).toBe('vitest-config-debug');
    expect(slugifySkillName('   ')).toBe('learned-skill');
    expect(slugifySkillName('A'.repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it('saveLearnedSkill writes a SKILL.md with kind: learned', async () => {
    const r = await saveLearnedSkill({
      name: 'Fix Vitest ESM Resolver',
      description: 'How to fix vitest ESM module resolution issues.',
      triggers: ['vitest', 'esm'],
      body: '## Steps\n\n1. ...',
      createdBy: 'hercules',
      createdFromSession: 'sess123',
      createdReason: 'Spent 6 rounds debugging the same vitest config.',
      slugSuffix: '',
      dir
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('learned');
    expect(r.value.createdBy).toBe('hercules');
    const onDisk = await readFile(r.value.path, 'utf8');
    expect(onDisk).toContain('kind: learned');
    expect(onDisk).toContain('createdBy: hercules');
    // Round-trip: loadSkills should re-parse it.
    const loaded = await loadSkills({ dir });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const found = loaded.value.find((s) => s.name === 'fix-vitest-esm-resolver');
    expect(found?.kind).toBe('learned');
  });

  it('saveLearnedSkill stamps version + createdAt and timestamp-suffixed dir', async () => {
    const r = await saveLearnedSkill({
      name: 'pin pnpm version',
      description: 'lock the pnpm version in package.json packageManager field',
      triggers: ['pnpm'],
      body: '## Steps\n\n1. ...',
      createdBy: 'hermes',
      slugSuffix: 'abc',
      now: '2026-01-02T03:04:05.000Z',
      version: '0.2.0',
      dir
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.version).toBe('0.2.0');
    expect(r.value.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(r.value.path).toContain('pin-pnpm-version-abc');
    expect(r.value.name).toBe('pin-pnpm-version');
    const onDisk = await readFile(r.value.path, 'utf8');
    expect(onDisk).toContain("version: 0.2.0");
    expect(onDisk).toContain('createdAt: ');
  });

  it('saveLearnedSkill twice with different suffixes keeps both iterations on disk', async () => {
    const a = await saveLearnedSkill({
      name: 'lesson',
      description: 'd',
      triggers: [],
      body: 'first',
      createdBy: 'hermes',
      slugSuffix: 'v1',
      dir
    });
    const b = await saveLearnedSkill({
      name: 'lesson',
      description: 'd',
      triggers: [],
      body: 'second',
      createdBy: 'hermes',
      slugSuffix: 'v2',
      version: '0.2.0',
      dir
    });
    expect(a.ok && b.ok).toBe(true);
    const loaded = await loadSkills({ dir });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Both iterations parse, both share the same `name` slug.
    const matching = loaded.value.filter((s) => s.name === 'lesson');
    expect(matching).toHaveLength(2);
  });

  it('loadSkills excludes skills with disabled: true', async () => {
    await mkdir(join(dir, 'noisy'));
    await writeFile(
      join(dir, 'noisy', 'SKILL.md'),
      '---\nname: noisy\ndescription: a noisy learned skill\nkind: learned\ndisabled: true\n---\n# body\n',
      'utf8'
    );
    const r = await loadSkills({ dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.find((s) => s.name === 'noisy')).toBeUndefined();
  });

  it('setSkillDisabled toggles the disabled flag in place', async () => {
    const saved = await saveLearnedSkill({
      name: 'toggleable',
      description: 'd',
      triggers: [],
      body: 'body',
      createdBy: 'hermes',
      slugSuffix: '',
      dir
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const off = await setSkillDisabled(saved.value.path, true);
    expect(off.ok).toBe(true);
    let onDisk = await readFile(saved.value.path, 'utf8');
    expect(onDisk).toContain('disabled: true');
    let loaded = await loadSkills({ dir });
    expect(loaded.ok && loaded.ok && loaded.value.find((s) => s.name === 'toggleable')).toBeFalsy();
    const on = await setSkillDisabled(saved.value.path, false);
    expect(on.ok).toBe(true);
    onDisk = await readFile(saved.value.path, 'utf8');
    expect(onDisk).not.toContain('disabled:');
    loaded = await loadSkills({ dir });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.find((s) => s.name === 'toggleable')).toBeDefined();
  });

  it('SkillRegistry.add overwrites existing skills', () => {
    const reg = new SkillRegistry([
      { name: 'a', description: 'old', triggers: [], kind: 'user', path: '/x', body: '' }
    ]);
    reg.add({ name: 'a', description: 'new', triggers: [], kind: 'learned', path: '/y', body: '' });
    expect(reg.get('a')?.description).toBe('new');
    expect(reg.get('a')?.kind).toBe('learned');
  });
});
