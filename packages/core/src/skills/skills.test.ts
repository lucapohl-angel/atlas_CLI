import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillRegistry, loadSkills, renderSkillIndex, saveLearnedSkill, slugifySkillName } from './loader.js';

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

  it('SkillRegistry.add overwrites existing skills', () => {
    const reg = new SkillRegistry([
      { name: 'a', description: 'old', triggers: [], kind: 'user', path: '/x', body: '' }
    ]);
    reg.add({ name: 'a', description: 'new', triggers: [], kind: 'learned', path: '/y', body: '' });
    expect(reg.get('a')?.description).toBe('new');
    expect(reg.get('a')?.kind).toBe('learned');
  });
});
