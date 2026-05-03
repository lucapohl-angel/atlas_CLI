import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProjectState, recommendAgent } from './index.js';

describe('orchestrator', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-orch-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('detects empty project', async () => {
    const s = await detectProjectState(dir);
    expect(s.hasPRD).toBe(false);
    expect(s.hasArchitecture).toBe(false);
    expect(s.storyCount).toBe(0);
  });

  it('recommends athena when PRD missing', async () => {
    const s = await detectProjectState(dir);
    const r = recommendAgent(s);
    expect(r.agent).toBe('athena');
  });

  it('recommends prometheus when only PRD exists', async () => {
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs', 'prd.md'), '# PRD\n');
    const s = await detectProjectState(dir);
    expect(recommendAgent(s).agent).toBe('prometheus');
  });

  it('recommends athena to scaffold context pack when arch exists but pack missing', async () => {
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs', 'prd.md'), '# PRD\n');
    await writeFile(join(dir, 'docs', 'architecture.md'), '# arch\n');
    const s = await detectProjectState(dir);
    const r = recommendAgent(s);
    expect(r.agent).toBe('athena');
    expect(r.reason).toContain('context');
  });

  it('recommends hestia when architecture exists but no stories', async () => {
    await mkdir(join(dir, 'docs'));
    await mkdir(join(dir, 'context'));
    await writeFile(join(dir, 'docs', 'prd.md'), '# PRD\n');
    await writeFile(join(dir, 'docs', 'architecture.md'), '# arch\n');
    await writeFile(join(dir, 'context', 'project-overview.md'), '# overview\n');
    const s = await detectProjectState(dir);
    expect(recommendAgent(s).agent).toBe('hestia');
  });

  it('recommends hercules when stories exist', async () => {
    await mkdir(join(dir, 'docs', 'stories'), { recursive: true });
    await mkdir(join(dir, 'context'));
    await writeFile(join(dir, 'docs', 'prd.md'), '# PRD\n');
    await writeFile(join(dir, 'docs', 'architecture.md'), '# arch\n');
    await writeFile(join(dir, 'context', 'project-overview.md'), '# overview\n');
    await writeFile(join(dir, 'docs', 'stories', 's1.md'), '# story\n');
    const s = await detectProjectState(dir);
    const r = recommendAgent(s);
    expect(r.agent).toBe('hercules');
    expect(r.reason).toContain('1');
  });
});
