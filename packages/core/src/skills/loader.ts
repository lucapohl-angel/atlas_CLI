/**
 * Skill loader — scans `~/.atlas/skills/*​/SKILL.md`, parses frontmatter,
 * and exposes a registry that supports keyword-trigger matching.
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import { err, ok, type Result } from '../result.js';
import { SkillFrontmatterSchema, type Skill } from './types.js';

const log = childLogger('skills');

export const DEFAULT_SKILLS_DIR: string = join(homedir(), '.atlas', 'skills');

export interface LoadSkillsOptions {
  readonly dir?: string;
}

export const loadSkills = async (
  options: LoadSkillsOptions = {}
): Promise<Result<readonly Skill[], AtlasError>> => {
  const dir = options.dir ?? DEFAULT_SKILLS_DIR;
  let entries: string[];
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return ok([]);
    entries = await readdir(dir);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return ok([]);
    return err(
      atlasError('SKILL_PARSE_FAILED', `failed to scan skills dir ${dir}`, { cause: e })
    );
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    const skillPath = join(dir, entry, 'SKILL.md');
    try {
      const raw = await readFile(skillPath, 'utf8');
      const parsed = matter(raw);
      const fm = SkillFrontmatterSchema.safeParse(parsed.data);
      if (!fm.success) {
        log.warn({ skillPath, issues: fm.error.issues }, 'skipping skill: invalid frontmatter');
        continue;
      }
      skills.push({ ...fm.data, path: skillPath, body: parsed.content.trim() });
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') continue;
      log.warn({ skillPath, err: e }, 'skipping unreadable SKILL.md');
    }
  }
  return ok(skills);
};

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  constructor(initial: readonly Skill[] = []) {
    for (const s of initial) this.skills.set(s.name, s);
  }

  list(): readonly Skill[] {
    return [...this.skills.values()];
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** Add (or replace) a skill at runtime — used by the self-improvement loop. */
  add(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  /**
   * Returns the skills whose triggers (or name) appear as substrings in
   * `text`. Matching is case-insensitive. Used by the orchestrator to
   * propose skills based on the user's request.
   */
  match(text: string): readonly Skill[] {
    const haystack = text.toLowerCase();
    const out: Skill[] = [];
    for (const skill of this.skills.values()) {
      const needles = [skill.name, ...skill.triggers];
      if (needles.some((n) => haystack.includes(n.toLowerCase()))) {
        out.push(skill);
      }
    }
    return out;
  }
}

/** Render skills as a one-line-each index suitable for system-prompt injection. */
export const renderSkillIndex = (skills: readonly Skill[]): string => {
  if (skills.length === 0) return '(no skills installed)';
  return skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
};

/** Strict slug — lowercase, alnum + dashes, max 60 chars. Used for skill dir names. */
export const slugifySkillName = (raw: string): string => {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'learned-skill';
};

export interface SaveLearnedSkillInput {
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly body: string;
  readonly createdBy: string;
  readonly createdFromSession?: string;
  readonly createdReason?: string;
  /** Override target dir (defaults to `~/.atlas/skills`). For tests. */
  readonly dir?: string;
}

/**
 * Persist a learned skill to disk as `<dir>/<slug>/SKILL.md`. Atomic via
 * tmpfile + rename. Returns the parsed `Skill` ready to add to a registry.
 */
export const saveLearnedSkill = async (
  input: SaveLearnedSkillInput
): Promise<Result<Skill, AtlasError>> => {
  const dir = input.dir ?? DEFAULT_SKILLS_DIR;
  const slug = slugifySkillName(input.name);
  const skillDir = join(dir, slug);
  const target = join(skillDir, 'SKILL.md');
  const fm = {
    name: slug,
    description: input.description,
    triggers: [...input.triggers],
    kind: 'learned' as const,
    createdBy: input.createdBy,
    ...(input.createdFromSession ? { createdFromSession: input.createdFromSession } : {}),
    ...(input.createdReason ? { createdReason: input.createdReason } : {})
  };
  const md = matter.stringify(`\n${input.body.trim()}\n`, fm);
  try {
    await mkdir(skillDir, { recursive: true });
    const tmp = join(tmpdir(), `atlas-skill-${slug}-${Date.now()}.md`);
    await writeFile(tmp, md, 'utf8');
    await rename(tmp, target);
  } catch (e) {
    return err(
      atlasError('SKILL_PARSE_FAILED', `failed to save learned skill ${slug}`, { cause: e })
    );
  }
  return ok({
    ...fm,
    path: target,
    body: input.body.trim()
  });
};
