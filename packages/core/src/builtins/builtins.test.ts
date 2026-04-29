import { describe, expect, it } from 'vitest';
import { ALL_BUILTINS, BUILTIN_AGENTS } from './index.js';
import { AgentFrontmatterSchema } from '../agents/types.js';
import { SkillFrontmatterSchema } from '../skills/types.js';
import matter from 'gray-matter';

describe('builtins', () => {
  it('every built-in agent has valid frontmatter', () => {
    for (const f of BUILTIN_AGENTS) {
      const parsed = matter(f.content);
      const r = AgentFrontmatterSchema.safeParse(parsed.data);
      expect(r.success, `${f.relPath} frontmatter: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
  });

  it('builtins set includes athena and at least one skill', () => {
    const paths = ALL_BUILTINS.map((f) => f.relPath);
    expect(paths).toContain('agents/athena/AGENT.md');
    expect(paths.some((p) => p.startsWith('skills/'))).toBe(true);
  });

  it('skill frontmatter validates', () => {
    for (const f of ALL_BUILTINS) {
      if (!f.relPath.startsWith('skills/')) continue;
      const r = SkillFrontmatterSchema.safeParse(matter(f.content).data);
      expect(r.success, `${f.relPath}`).toBe(true);
    }
  });

  it('ships the atlas orchestrator as a framework agent', () => {
    const atlas = BUILTIN_AGENTS.find((f) => f.relPath === 'agents/atlas/AGENT.md');
    expect(atlas).toBeDefined();
    const fm = matter(atlas!.content).data as Record<string, unknown>;
    expect(fm['kind']).toBe('framework');
    expect(fm['name']).toBe('atlas');
    expect(fm['personaAlias']).toBe('Atlas');
  });

  it('every framework agent declares kind: framework', () => {
    for (const f of BUILTIN_AGENTS) {
      const fm = matter(f.content).data as Record<string, unknown>;
      expect(fm['kind'], `${f.relPath}`).toBe('framework');
    }
  });
});
