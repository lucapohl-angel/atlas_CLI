import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateOnboardCost, writeRepoMap } from './scan.js';

describe('onboarding scan', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-onboard-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { react: '^19.0.0' } }, null, 2),
      'utf8'
    );
    await writeFile(join(dir, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('estimates token and stack metadata', async () => {
    const r = await estimateOnboardCost({ cwd: dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.fileCount).toBeGreaterThan(0);
    expect(r.value.estimatedInputTokens).toBeGreaterThan(0);
    expect(r.value.detected.frameworks).toContain('react');
    expect(r.value.detected.languages).toContain('TypeScript');
  });

  it('writes repo-map markdown', async () => {
    const r = await writeRepoMap({ cwd: dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = await readFile(r.value.path, 'utf8');
    expect(out).toContain('# Repository Map');
  });
});
