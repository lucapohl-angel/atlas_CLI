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
      if (fm.data.disabled === true) {
        log.debug({ skillPath, name: fm.data.name }, 'skipping disabled skill');
        continue;
      }
      skills.push({ ...fm.data, path: skillPath, body: parsed.content.trim() });
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') continue;
      log.warn({ skillPath, err: e }, 'skipping unreadable SKILL.md');
    }
  }
  // Deduplicate by name: when multiple iterations of the same skill exist
  // on disk (e.g. learned-skill-a, learned-skill-b), keep the one with the
  // latest `createdAt`. Skills missing `createdAt` are treated as oldest so
  // a freshly-stamped iteration always wins. Tie-break by path for stability.
  const winners = new Map<string, Skill>();
  for (const s of skills) {
    const existing = winners.get(s.name);
    if (existing === undefined) {
      winners.set(s.name, s);
      continue;
    }
    const a = existing.createdAt ?? '';
    const b = s.createdAt ?? '';
    if (b > a || (b === a && s.path > existing.path)) {
      winners.set(s.name, s);
    }
  }
  return ok([...winners.values()]);
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
  /**
   * Override the timestamp suffix appended to the slug. Pass an empty
   * string to disable the suffix entirely (useful for tests asserting
   * a deterministic path). Defaults to `Date.now()` base36-encoded.
   */
  readonly slugSuffix?: string;
  /**
   * Override the `created_at` ISO-8601 timestamp. Defaults to
   * `new Date().toISOString()`. For tests / determinism.
   */
  readonly now?: string;
  /** Initial semantic version. Defaults to `0.1.0`. */
  readonly version?: string;
}

/**
 * Persist a learned skill to disk as `<dir>/<slug>-<ts>/SKILL.md`. Atomic
 * via tmpfile + rename. Returns the parsed `Skill` ready to add to a
 * registry.
 *
 * The timestamp suffix on the directory name lets the self-improvement
 * loop save multiple iterations of the "same" lesson without clobbering
 * earlier drafts — useful for the future `/skills history <name>` UI
 * and for letting users compare/merge versions by hand.
 */
export const saveLearnedSkill = async (
  input: SaveLearnedSkillInput
): Promise<Result<Skill, AtlasError>> => {
  const dir = input.dir ?? DEFAULT_SKILLS_DIR;
  const baseSlug = slugifySkillName(input.name);
  const suffix = input.slugSuffix ?? Date.now().toString(36);
  const dirSlug = suffix.length > 0 ? `${baseSlug}-${suffix}` : baseSlug;
  const skillDir = join(dir, dirSlug);
  const target = join(skillDir, 'SKILL.md');
  const createdAt = input.now ?? new Date().toISOString();
  const version = input.version ?? '0.1.0';
  const fm = {
    name: baseSlug,
    description: input.description,
    triggers: [...input.triggers],
    kind: 'learned' as const,
    createdBy: input.createdBy,
    version,
    createdAt,
    ...(input.createdFromSession ? { createdFromSession: input.createdFromSession } : {}),
    ...(input.createdReason ? { createdReason: input.createdReason } : {})
  };
  const md = matter.stringify(`\n${input.body.trim()}\n`, fm);
  try {
    await mkdir(skillDir, { recursive: true });
    const tmp = join(tmpdir(), `atlas-skill-${dirSlug}-${Date.now()}.md`);
    await writeFile(tmp, md, 'utf8');
    await rename(tmp, target);
  } catch (e) {
    return err(
      atlasError('SKILL_PARSE_FAILED', `failed to save learned skill ${dirSlug}`, { cause: e })
    );
  }
  return ok({
    ...fm,
    path: target,
    body: input.body.trim()
  });
};

/**
 * Toggle the `disabled` frontmatter flag on a skill file in place. Atomic
 * via tmpfile + rename. The on-disk body is preserved verbatim. Used by
 * the TUI's `/skills disable|enable <name>` command.
 *
 * Returns the absolute path that was rewritten so the caller can show
 * a confirmation. Returns `SKILL_PARSE_FAILED` if the file is missing
 * or has invalid frontmatter.
 */
export const setSkillDisabled = async (
  skillPath: string,
  disabled: boolean
): Promise<Result<string, AtlasError>> => {
  let raw: string;
  try {
    raw = await readFile(skillPath, 'utf8');
  } catch (e) {
    return err(
      atlasError('SKILL_PARSE_FAILED', `failed to read skill ${skillPath}`, { cause: e })
    );
  }
  const parsed = matter(raw);
  const fm = SkillFrontmatterSchema.safeParse(parsed.data);
  if (!fm.success) {
    return err(
      atlasError('SKILL_PARSE_FAILED', `invalid skill frontmatter at ${skillPath}`, {
        context: { issues: fm.error.issues }
      })
    );
  }
  const nextFm: Record<string, unknown> = { ...fm.data };
  if (disabled) {
    nextFm.disabled = true;
  } else {
    delete nextFm.disabled;
  }
  const md = matter.stringify(parsed.content, nextFm);
  try {
    const tmp = join(tmpdir(), `atlas-skill-toggle-${Date.now()}.md`);
    await writeFile(tmp, md, 'utf8');
    await rename(tmp, skillPath);
  } catch (e) {
    return err(
      atlasError('SKILL_PARSE_FAILED', `failed to write skill ${skillPath}`, { cause: e })
    );
  }
  return ok(skillPath);
};
