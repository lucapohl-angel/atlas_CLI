import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_CHECKLISTS } from '../builtins/checklists.js';
import {
  findChecklist,
  loadChecklists,
  parseChecklist,
  runChecklist
} from './index.js';

const sampleYaml = `
id: prd-ready
version: 1
title: PRD Readiness
owner: athena
appliesTo: docs/prd.md
items:
  - id: problem-stated
    text: Problem section is in the user's vocabulary.
    severity: blocker
  - id: metrics-measurable
    text: Every success metric has a target.
    severity: blocker
  - id: open-questions-tracked
    text: Open Questions section exists.
    severity: warning
`;

describe('checklists: parse', () => {
  it('parses a valid checklist', () => {
    const r = parseChecklist(sampleYaml, '/virtual/prd-ready.yaml');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('prd-ready');
    expect(r.value.items).toHaveLength(3);
    expect(r.value.items[0]!.severity).toBe('blocker');
  });

  it('rejects invalid YAML', () => {
    const r = parseChecklist(': : :', '/virtual/x.yaml');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CHECKLIST_PARSE_FAILED');
  });

  it('rejects duplicate item ids', () => {
    const dup = `
id: dup
version: 1
title: Dup
items:
  - id: same
    text: a
  - id: same
    text: b
`;
    const r = parseChecklist(dup, '/virtual/dup.yaml');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/duplicate item id/);
  });
});

describe('checklists: run', () => {
  const checklistRes = parseChecklist(sampleYaml, '/virtual/prd-ready.yaml');
  if (!checklistRes.ok) throw new Error('fixture parse failed');
  const checklist = checklistRes.value;

  it('passes when no blocker fails', () => {
    const r = runChecklist({
      checklist,
      results: [
        { itemId: 'problem-stated', status: 'pass' },
        { itemId: 'metrics-measurable', status: 'pass' },
        { itemId: 'open-questions-tracked', status: 'fail', note: 'no section yet' }
      ]
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.verdict).toBe('pass');
    expect(r.value.counts.blockerFails).toBe(0);
    expect(r.value.counts.warningFails).toBe(1);
  });

  it('fails when any blocker fails', () => {
    const r = runChecklist({
      checklist,
      results: [
        { itemId: 'problem-stated', status: 'fail' },
        { itemId: 'metrics-measurable', status: 'pass' },
        { itemId: 'open-questions-tracked', status: 'pass' }
      ]
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.verdict).toBe('fail');
    expect(r.value.counts.blockerFails).toBe(1);
  });

  it('rejects results that omit declared items', () => {
    const r = runChecklist({
      checklist,
      results: [{ itemId: 'problem-stated', status: 'pass' }]
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CHECKLIST_INPUT_INVALID');
    expect(r.error.message).toMatch(/missing result/);
  });

  it('rejects results that reference unknown items', () => {
    const r = runChecklist({
      checklist,
      results: [
        { itemId: 'problem-stated', status: 'pass' },
        { itemId: 'metrics-measurable', status: 'pass' },
        { itemId: 'open-questions-tracked', status: 'pass' },
        { itemId: 'bogus', status: 'pass' }
      ]
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/unknown item/);
  });

  it('rejects when caller is not the owner', () => {
    const r = runChecklist({
      checklist,
      results: [
        { itemId: 'problem-stated', status: 'pass' },
        { itemId: 'metrics-measurable', status: 'pass' },
        { itemId: 'open-questions-tracked', status: 'pass' }
      ],
      callingAgent: { name: 'hercules' }
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CHECKLIST_OWNER_MISMATCH');
  });

  it('allows the owner', () => {
    const r = runChecklist({
      checklist,
      results: [
        { itemId: 'problem-stated', status: 'pass' },
        { itemId: 'metrics-measurable', status: 'pass' },
        { itemId: 'open-questions-tracked', status: 'pass' }
      ],
      callingAgent: { name: 'athena' }
    });
    expect(r.ok).toBe(true);
  });
});

describe('checklists: loader', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-cl-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads checklists from disk', async () => {
    await writeFile(join(dir, 'prd-ready.yaml'), sampleYaml, 'utf8');
    const r = await loadChecklists({ dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    expect(r.value[0]!.id).toBe('prd-ready');
  });

  it('returns empty array when dir does not exist', async () => {
    const r = await loadChecklists({ dir: join(dir, 'nope') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(0);
  });

  it('newest version wins on duplicate id', async () => {
    await writeFile(join(dir, 'a.yaml'), sampleYaml, 'utf8');
    const v2 = sampleYaml.replace('version: 1', 'version: 2');
    await writeFile(join(dir, 'b.yaml'), v2, 'utf8');
    const r = await loadChecklists({ dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    expect(r.value[0]!.version).toBe(2);
  });

  it('skips invalid checklists without failing the whole scan', async () => {
    await writeFile(join(dir, 'good.yaml'), sampleYaml, 'utf8');
    await writeFile(join(dir, 'bad.yaml'), 'not: [valid', 'utf8');
    const r = await loadChecklists({ dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
  });

  it('findChecklist returns CHECKLIST_NOT_FOUND when missing', async () => {
    await mkdir(dir, { recursive: true });
    const r = await findChecklist('nope', { dir });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CHECKLIST_NOT_FOUND');
  });

  it('project overlay wins over user overlay for same checklist id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atlas-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'atlas-cwd-'));
    await mkdir(join(home, '.atlas', 'checklists'), { recursive: true });
    await mkdir(join(cwd, '.atlas', 'checklists'), { recursive: true });

    const userChecklist = sampleYaml.replace('PRD Readiness', 'User Readiness');
    const projectChecklist = sampleYaml.replace('PRD Readiness', 'Project Readiness');
    await writeFile(join(home, '.atlas', 'checklists', 'prd-ready.yaml'), userChecklist, 'utf8');
    await writeFile(join(cwd, '.atlas', 'checklists', 'prd-ready.yaml'), projectChecklist, 'utf8');

    const r = await loadChecklists({ cwd, home });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const found = r.value.find((c) => c.id === 'prd-ready');
      expect(found?.title).toBe('Project Readiness');
    }

    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });
});

describe('checklists: builtins', () => {
  it('every shipped checklist parses cleanly', () => {
    expect(BUILTIN_CHECKLISTS.length).toBeGreaterThanOrEqual(17);
    for (const c of BUILTIN_CHECKLISTS) {
      const r = parseChecklist(c.content, c.relPath);
      if (!r.ok) throw new Error(`${c.relPath}: ${r.error.message}`);
      expect(r.value.items.length).toBeGreaterThan(0);
    }
  });

  it('every shipped checklist has a unique id', () => {
    const seen = new Set<string>();
    for (const c of BUILTIN_CHECKLISTS) {
      const r = parseChecklist(c.content, c.relPath);
      if (!r.ok) throw new Error('parse failed');
      expect(seen.has(r.value.id), `duplicate id: ${r.value.id}`).toBe(false);
      seen.add(r.value.id);
    }
  });

  it('referenced checklist ids in built-in personas resolve', async () => {
    // Quick sanity check: collect the ids personas cite and verify they exist.
    const ids = new Set(
      BUILTIN_CHECKLISTS.map((c) => {
        const r = parseChecklist(c.content, c.relPath);
        if (!r.ok) throw new Error('parse failed');
        return r.value.id;
      })
    );
    const expected = [
      'prd-ready',
      'architecture-ready',
      'ux-spec-ready',
      'design-system-ready',
      'epic-ready',
      'story-ready',
      'story-done',
      'migration-ready',
      'release-ready',
      'docs-ready'
    ];
    for (const id of expected) {
      expect(ids.has(id), `missing built-in checklist: ${id}`).toBe(true);
    }
  });
});
