import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_WORKFLOWS } from '../builtins/workflows.js';
import { emitHandoff } from '../stories/handoff.js';
import { loadChains, lookupChain, parseChains, recommendNext } from './index.js';

const sampleYaml = `
version: 1
chains:
  - fromAgent: athena
    command: write-prd
    toAgent: prometheus
    nextCommand: write-architecture
    reason: PRD ready; hand to architect
  - fromAgent: athena
    toAgent: hermes
    nextCommand: write-epics
    reason: athena default fallback
`;

describe('workflows: parse', () => {
  it('parses a chains file', () => {
    const r = parseChains(sampleYaml, '/x.yaml');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    expect(r.value[0]!.toAgent).toBe('prometheus');
  });

  it('rejects malformed YAML', () => {
    const r = parseChains(': : :', '/x.yaml');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CHAIN_PARSE_FAILED');
  });

  it('rejects invalid identifiers', () => {
    const bad = `
version: 1
chains:
  - fromAgent: BadName
    toAgent: prometheus
`;
    const r = parseChains(bad, '/x.yaml');
    expect(r.ok).toBe(false);
  });
});

describe('workflows: lookupChain', () => {
  const r = parseChains(sampleYaml, '/x.yaml');
  if (!r.ok) throw new Error('fixture failed');
  const chains = r.value;

  it('matches command-specific entry over wildcard', () => {
    const step = lookupChain(chains, 'athena', 'write-prd');
    expect(step?.toAgent).toBe('prometheus');
  });

  it('falls back to wildcard when no command match', () => {
    const step = lookupChain(chains, 'athena', 'unknown');
    expect(step?.toAgent).toBe('hermes');
  });

  it('returns undefined when nothing matches', () => {
    expect(lookupChain(chains, 'nobody')).toBeUndefined();
  });
});

describe('workflows: loadChains', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-wf-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty array when no file exists', async () => {
    const r = await loadChains({ dir, cwd: dir, home: dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(0);
  });

  it('loads from explicit dir', async () => {
    await writeFile(join(dir, 'chains.yaml'), sampleYaml, 'utf8');
    const r = await loadChains({ dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
  });

  it('project-local overrides home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atlas-home-'));
    await mkdir(join(home, '.atlas', 'workflows'), { recursive: true });
    await writeFile(
      join(home, '.atlas', 'workflows', 'chains.yaml'),
      'version: 1\nchains:\n  - fromAgent: home\n    toAgent: hermes\n',
      'utf8'
    );
    await mkdir(join(dir, '.atlas', 'workflows'), { recursive: true });
    await writeFile(join(dir, '.atlas', 'workflows', 'chains.yaml'), sampleYaml, 'utf8');
    const r = await loadChains({ cwd: dir, home });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]!.fromAgent).toBe('athena');
    await rm(home, { recursive: true, force: true });
  });
});

describe('workflows: recommendNext', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'atlas-rn-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('handoff queue wins over chain and state', async () => {
    await emitHandoff({
      fromAgent: 'athena',
      toAgent: 'prometheus',
      command: 'write-architecture',
      cwd,
      now: '2026-05-01T00:00:00.000Z'
    });
    const r = await recommendNext({ cwd, home: cwd });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.source).toBe('handoff');
    expect(r.value.agent).toBe('prometheus');
    expect(r.value.command).toBe('write-architecture');
  });

  it('falls back to chain when no handoffs and fromAgent supplied', async () => {
    await mkdir(join(cwd, '.atlas', 'workflows'), { recursive: true });
    await writeFile(join(cwd, '.atlas', 'workflows', 'chains.yaml'), sampleYaml, 'utf8');
    const r = await recommendNext({
      cwd,
      home: cwd,
      fromAgent: 'athena',
      lastCommand: 'write-prd'
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.source).toBe('chain');
    expect(r.value.agent).toBe('prometheus');
    expect(r.value.command).toBe('write-architecture');
  });

  it('falls back to state when nothing else applies', async () => {
    const r = await recommendNext({ cwd, home: cwd });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.source).toBe('state');
    expect(r.value.agent).toBe('athena');
  });
});

describe('workflows: builtins', () => {
  it('default chains.yaml parses cleanly', () => {
    const f = BUILTIN_WORKFLOWS.find((x) => x.relPath.endsWith('chains.yaml'));
    expect(f).toBeTruthy();
    const r = parseChains(f!.content, f!.relPath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBeGreaterThan(5);
    // canonical pipeline anchor: athena write-prd → prometheus
    const step = lookupChain(r.value, 'athena', 'write-prd');
    expect(step?.toAgent).toBe('prometheus');
  });
});
