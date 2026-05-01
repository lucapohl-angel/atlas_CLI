import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES } from '../builtins/templates.js';
import {
  findTemplate,
  loadTemplates,
  parseTemplate,
  renderTemplate
} from './index.js';

const sampleYaml = `
id: prd
version: 1
title: Product Requirements Document
owner: athena
output: docs/prd.md
inputs:
  - name: project_name
    type: string
    required: true
  - name: problem_statement
    type: text
    required: true
  - name: users
    type: list
sections:
  - id: problem
    title: Problem
    elicit: true
    body: |
      {{problem_statement}}
  - id: users
    title: Users
    repeatable: true
    body: |
      - {{item}}
  - id: enterprise
    title: Enterprise considerations
    condition: project_kind == 'enterprise'
    body: |
      Compliance owner: {{compliance_owner}}
`;

describe('templates: parse + render', () => {
  it('parses a valid template', () => {
    const r = parseTemplate(sampleYaml, '/virtual/prd.yaml');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('prd');
    expect(r.value.sections).toHaveLength(3);
  });

  it('rejects invalid YAML', () => {
    const r = parseTemplate('id: 123\nversion: not-a-number\n', '/virtual/x.yaml');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TEMPLATE_PARSE_FAILED');
  });

  it('renders sections with handlebars', () => {
    const t = parseTemplate(sampleYaml, '/virtual/prd.yaml');
    if (!t.ok) throw new Error('parse failed');
    const r = renderTemplate({
      template: t.value,
      inputs: {
        project_name: 'Atlas',
        problem_statement: 'devs need an SDD CLI',
        users: ['indie devs', 'small teams']
      }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.content).toContain('## Problem');
    expect(r.value.content).toContain('devs need an SDD CLI');
    expect(r.value.content).toContain('- indie devs');
    expect(r.value.content).toContain('- small teams');
    // condition false → enterprise section omitted
    expect(r.value.content).not.toContain('Enterprise considerations');
  });

  it('hard-fails when an elicit section\'s referenced input is missing', () => {
    const t = parseTemplate(sampleYaml, '/virtual/prd.yaml');
    if (!t.ok) throw new Error('parse failed');
    const r = renderTemplate({
      template: t.value,
      inputs: { project_name: 'Atlas', problem_statement: '' }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('TEMPLATE_INPUT_MISSING');
      expect(r.error.message).toContain('problem_statement');
    }
  });

  it('hard-fails when calling agent is not the owner', () => {
    const t = parseTemplate(sampleYaml, '/virtual/prd.yaml');
    if (!t.ok) throw new Error('parse failed');
    const r = renderTemplate({
      template: t.value,
      inputs: { project_name: 'Atlas', problem_statement: 'x' },
      callingAgent: { name: 'hercules' }
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TEMPLATE_OWNER_MISMATCH');
  });

  it('allows the owner', () => {
    const t = parseTemplate(sampleYaml, '/virtual/prd.yaml');
    if (!t.ok) throw new Error('parse failed');
    const r = renderTemplate({
      template: t.value,
      inputs: { project_name: 'Atlas', problem_statement: 'x' },
      callingAgent: { name: 'athena' }
    });
    expect(r.ok).toBe(true);
  });

  it('renders conditional section when truthy', () => {
    const t = parseTemplate(sampleYaml, '/virtual/prd.yaml');
    if (!t.ok) throw new Error('parse failed');
    const r = renderTemplate({
      template: t.value,
      inputs: {
        project_name: 'Atlas',
        problem_statement: 'x',
        project_kind: 'enterprise',
        compliance_owner: 'legal@x'
      }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.content).toContain('Enterprise considerations');
    expect(r.value.content).toContain('legal@x');
  });

  it('repeatable section with empty array renders _(none)_', () => {
    const t = parseTemplate(sampleYaml, '/virtual/prd.yaml');
    if (!t.ok) throw new Error('parse failed');
    const r = renderTemplate({
      template: t.value,
      inputs: { project_name: 'Atlas', problem_statement: 'x', users: [] }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.content).toContain('## Users\n\n_(none)_');
  });
});

describe('templates: loader', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-templates-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads templates from disk', async () => {
    await writeFile(join(dir, 'prd.yaml'), sampleYaml, 'utf8');
    const r = await loadTemplates({ dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((t) => t.id)).toEqual(['prd']);
  });

  it('returns empty array when dir missing', async () => {
    const r = await loadTemplates({ dir: join(dir, 'nope') });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('newest version wins on duplicate id', async () => {
    await writeFile(join(dir, 'prd-v1.yaml'), sampleYaml, 'utf8');
    await writeFile(
      join(dir, 'prd-v2.yaml'),
      sampleYaml.replace('version: 1', 'version: 2'),
      'utf8'
    );
    const r = await loadTemplates({ dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    expect(r.value[0]!.version).toBe(2);
  });

  it('findTemplate returns NOT_FOUND when missing', async () => {
    await mkdir(dir, { recursive: true });
    const r = await findTemplate('nope', { dir });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('skips invalid templates without failing the whole scan', async () => {
    await writeFile(join(dir, 'prd.yaml'), sampleYaml, 'utf8');
    await writeFile(join(dir, 'broken.yaml'), 'id: 123\nversion: nope\n', 'utf8');
    const r = await loadTemplates({ dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    expect(r.value[0]!.id).toBe('prd');
  });
});

describe('templates: builtins', () => {
  it('every shipped template parses cleanly', () => {
    expect(BUILTIN_TEMPLATES.length).toBeGreaterThanOrEqual(14);
    for (const t of BUILTIN_TEMPLATES) {
      const r = parseTemplate(t.content, t.relPath);
      if (!r.ok) {
        throw new Error(`${t.relPath}: ${r.error.message}`);
      }
      expect(r.value.sections.length).toBeGreaterThan(0);
    }
  });

  it('every shipped template declares an owner', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const r = parseTemplate(t.content, t.relPath);
      if (!r.ok) throw new Error('parse failed');
      expect(r.value.owner, `${t.relPath} missing owner`).toBeTruthy();
    }
  });
});
