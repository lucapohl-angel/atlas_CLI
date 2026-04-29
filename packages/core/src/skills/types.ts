/**
 * Skill = procedural knowledge bundle that an agent can load on-demand.
 *
 * Format: `~/.atlas/skills/<name>/SKILL.md` with YAML frontmatter:
 *
 *   ---
 *   name: my-skill
 *   description: One-line description shown in the skill index.
 *   triggers:
 *     - "react component"
 *     - "tailwind"
 *   ---
 *   # body markdown describing the procedure...
 */
import { z } from 'zod';

export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  /** Optional substring/regex triggers the agent matches against context. */
  triggers: z.array(z.string()).default([])
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface Skill extends SkillFrontmatter {
  /** Absolute path to SKILL.md. */
  readonly path: string;
  /** The markdown body (everything after the frontmatter). */
  readonly body: string;
}
