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

  it('project overlay wins over user overlay for same template id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atlas-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'atlas-cwd-'));
    await mkdir(join(home, '.atlas', 'templates'), { recursive: true });
    await mkdir(join(cwd, '.atlas', 'templates'), { recursive: true });

    const userTpl = sampleYaml.replace('Product Requirements Document', 'User PRD');
    const projectTpl = sampleYaml.replace('Product Requirements Document', 'Project PRD');
    await writeFile(join(home, '.atlas', 'templates', 'prd.yaml'), userTpl, 'utf8');
    await writeFile(join(cwd, '.atlas', 'templates', 'prd.yaml'), projectTpl, 'utf8');

    const r = await loadTemplates({ cwd, home });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const prd = r.value.find((t) => t.id === 'prd');
      expect(prd?.title).toBe('Project PRD');
    }

    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
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

  it('design-system template renders DESIGN.md matching google-labs-code/design.md format', () => {
    const file = BUILTIN_TEMPLATES.find((t) => t.relPath.endsWith('design-system.yaml'));
    expect(file, 'design-system template missing').toBeTruthy();
    const parsed = parseTemplate(file!.content, file!.relPath);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const r = renderTemplate({
      template: parsed.value,
      inputs: {
        name: 'Heritage',
        description: 'Premium broadsheet aesthetic.',
        frontmatter_yaml:
          'colors:\n  primary: "#1A1C1E"\ntypography:\n  h1:\n    fontFamily: Public Sans\n    fontSize: 3rem',
        overview: 'Architectural Minimalism.',
        colors_prose: '- **Primary:** Deep ink.',
        typography_prose: '- **h1:** Headlines.'
      }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.value.content;

    // Spec: YAML frontmatter must be at byte 0, fenced by ---.
    expect(out.startsWith('---\n')).toBe(true);
    // Frontmatter block closes with --- followed by a blank line before the markdown body.
    expect(out).toContain('\n---\n\n## Overview\n');
    // name field present in frontmatter.
    expect(out).toMatch(/^---\nname: Heritage\n/);
    // description survives substitution unescaped.
    expect(out).toContain('description: Premium broadsheet aesthetic.');
    // Verbatim YAML body must NOT be HTML-escaped (would break `"#1A1C1E"`).
    expect(out).toContain('primary: "#1A1C1E"');
    // Section headings use ## per spec.
    expect(out).toContain('## Overview');
    expect(out).toContain('## Colors');
    expect(out).toContain('## Typography');
    // Sections must appear in canonical order.
    const order = ['## Overview', '## Colors', '## Typography'];
    let cursor = 0;
    for (const h of order) {
      const idx = out.indexOf(h, cursor);
      expect(idx, `heading ${h} out of order`).toBeGreaterThanOrEqual(cursor);
      cursor = idx + h.length;
    }
    // Optional sections absent when input not provided (spec: omit is allowed).
    expect(out).not.toContain('## Layout');
    expect(out).not.toContain("## Do's and Don'ts");
    // No duplicate `##` headings (spec: duplicate section is a parse error).
    const h2s = out.match(/^## .+$/gm) ?? [];
    expect(new Set(h2s).size).toBe(h2s.length);
  });
});
