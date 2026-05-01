import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt, loadAgents } from './loader.js';

describe('agents', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-agents-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads valid AGENT.md files', async () => {
    await mkdir(join(dir, 'athena'));
    await writeFile(
      join(dir, 'athena', 'AGENT.md'),
      '---\nname: athena\nrole: PM\ndescription: Wisdom\nmodel: anthropic/claude-sonnet-4\nhandoffs:\n  - to: prometheus\n    when: hasPRD\n---\nYou are Athena.\n',
      'utf8'
    );

    const r = await loadAgents({ dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    const a = r.value[0]!;
    expect(a.name).toBe('athena');
    expect(a.role).toBe('PM');
    expect(a.handoffs[0]?.to).toBe('prometheus');
    expect(a.systemPrompt).toContain('You are Athena.');
  });

  it('buildSystemPrompt composes role + persona + skills + handoffs + interaction protocol', () => {
    const prompt = buildSystemPrompt(
      {
        name: 'a',
        role: 'PM',
        description: 'd',
        personaAlias: 'Athena',
        mode: 'plan',
        thinkingEffort: 'medium',
        skills: [],
        handoffs: [{ to: 'b', when: 'always' }],
        commands: [{ name: 'help', description: 'show commands' }],
        path: '/x',
        systemPrompt: 'You are A.'
      },
      [{ name: 's1', description: 'first', triggers: [], path: '/', body: '' }]
    );
    // Role-first frame leads, persona body second, alias is a single line.
    expect(prompt.indexOf('PM')).toBeLessThan(prompt.indexOf('You are A.'));
    expect(prompt).toContain('You are A.');
    expect(prompt).toContain('I am Athena');
    expect(prompt).toContain('*help');
    expect(prompt).toContain('Mode: plan');
    expect(prompt).toContain('s1: first');
    expect(prompt).toContain('handoff to **b**');
    expect(prompt).toContain('<atlas:question>');
  });

  it('buildSystemPrompt renders persona DNA fields when present', () => {
    const prompt = buildSystemPrompt(
      {
        name: 'a',
        role: 'PM',
        description: 'd',
        mode: 'build',
        thinkingEffort: 'off',
        skills: [],
        handoffs: [],
        commands: [],
        path: '/x',
        systemPrompt: 'body',
        voiceDna: ['Crisp, no hedging', 'Quote the user verbatim'],
        activation: 'On first turn, list your *commands.',
        capabilityBoundaries: ['Never write code', 'Never push to a branch'],
        templates: ['prd-v1', 'epic-v1'],
        checklists: ['prd-readiness'],
        dataRefs: ['data/elicitation-methods.md'],
        examples: [{ input: '"build me a thing"', output: '## Problem\n...', note: 'starts with the problem, not the solution' }],
        authorizedSections: ['Problem', 'Goals'],
        forbiddenSections: ['Implementation Notes']
      },
      []
    );
    expect(prompt).toContain('## Voice DNA');
    expect(prompt).toContain('Crisp, no hedging');
    expect(prompt).toContain('## Activation');
    expect(prompt).toContain('list your *commands');
    expect(prompt).toContain('## Boundaries');
    expect(prompt).toContain('Never write code');
    expect(prompt).toContain('## Templates');
    expect(prompt).toContain('`prd-v1`');
    expect(prompt).toContain('## Checklists (definition-of-done)');
    expect(prompt).toContain('`prd-readiness`');
    expect(prompt).toContain('## Data references');
    expect(prompt).toContain('## Reference outputs');
    expect(prompt).toContain('starts with the problem');
    expect(prompt).toContain('## Story authoring');
    expect(prompt).toContain('`Problem`');
    expect(prompt).toContain('FORBIDDEN');
    expect(prompt).toContain('`Implementation Notes`');
  });

  it('buildSystemPrompt omits all DNA sections when fields are absent', () => {
    const prompt = buildSystemPrompt(
      {
        name: 'minimal',
        role: 'Dev',
        description: 'd',
        mode: 'build',
        thinkingEffort: 'off',
        skills: [],
        handoffs: [],
        commands: [],
        path: '/x',
        systemPrompt: 'body'
      },
      []
    );
    expect(prompt).not.toContain('## Voice DNA');
    expect(prompt).not.toContain('## Activation');
    expect(prompt).not.toContain('## Boundaries');
    expect(prompt).not.toContain('## Templates');
    expect(prompt).not.toContain('## Checklists');
    expect(prompt).not.toContain('## Reference outputs');
    expect(prompt).not.toContain('## Story authoring');
  });
});
