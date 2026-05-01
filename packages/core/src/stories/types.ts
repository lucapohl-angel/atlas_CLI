/**
 * Story-as-handoff types.
 *
 * A story file is a single markdown document under `docs/stories/<id>.md`
 * with a YAML frontmatter block and a body composed of H2 sections. Each
 * section is "owned" by exactly one framework agent — see
 * `decideSectionAccess` in `update.ts` for the mixed-mode authorization
 * convention (hard-fail on `forbiddenSections`, warn-and-write on
 * unauthorized-but-not-forbidden, allow on `authorizedSections`).
 */
import { z } from 'zod';

export const StoryStatusSchema = z.enum([
  'draft',
  'ready',
  'in-progress',
  'in-review',
  'done',
  'blocked'
]);
export type StoryStatus = z.infer<typeof StoryStatusSchema>;

export const StoryFrontmatterSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: StoryStatusSchema.default('draft'),
  agent: z.string().optional(),
  epic: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  links: z
    .object({
      prd: z.string().optional(),
      architecture: z.string().optional(),
      uxSpec: z.string().optional()
    })
    .partial()
    .optional()
});
export type StoryFrontmatter = z.infer<typeof StoryFrontmatterSchema>;

/** A parsed H2 section: the title (no leading "## ") and its body text. */
export interface StorySection {
  readonly title: string;
  readonly body: string;
}

export interface Story {
  readonly frontmatter: StoryFrontmatter;
  readonly sections: readonly StorySection[];
  /** Absolute path to the story file. */
  readonly path: string;
  /** The raw body (after the frontmatter), preserved verbatim. */
  readonly rawBody: string;
}

/**
 * Caller identity passed to `updateStorySection` to make the
 * authorization decision. `name` is the agent slug (e.g. `hercules`);
 * the two section lists default to "no opinion" when omitted, which
 * means everything is allowed (back-compat for unconstrained agents).
 */
export interface CallingAgent {
  readonly name: string;
  readonly authorizedSections?: readonly string[];
  readonly forbiddenSections?: readonly string[];
}
