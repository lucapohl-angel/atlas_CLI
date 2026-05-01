/**
 * Story section update + the mixed-mode authorization model.
 *
 * Mixed-mode rules (per design decision recorded in the Phase 5 plan):
 *
 *   1. If the section is in the calling agent's `forbiddenSections` —
 *      **hard-fail** with `STORY_SECTION_FORBIDDEN`. The write does not
 *      happen. The error names both the section and the calling agent.
 *
 *   2. If `authorizedSections` is set and the section is in it — **allow**
 *      silently.
 *
 *   3. If `authorizedSections` is set and the section is NOT in it (and
 *      not in `forbiddenSections`) — **warn-and-write**: the write
 *      succeeds, the function returns a `warning` string in its `ok`
 *      payload, and a "soft-boundary cross" line is appended to the
 *      story's `## Change Log` section so the audit trail is permanent.
 *
 *   4. If neither list is set on the calling agent (or no calling agent
 *      is supplied) — **allow** silently (back-compat for unconstrained
 *      agents and direct user invocations).
 *
 * The write is atomic: the new file is composed in memory, written to
 * a temp file, then `rename`d into place.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import { parseStory } from './loader.js';
import {
  StoryFrontmatterSchema,
  type CallingAgent,
  type Story,
  type StorySection
} from './types.js';

export type AuthorizationDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'warn'; readonly reason: string }
  | { readonly action: 'deny'; readonly reason: string };

/**
 * Apply the mixed-mode rules to a single (agent, section) pair. Pure
 * function; no I/O. Exported so callers can preflight a decision
 * without actually performing the write.
 */
export const decideSectionAccess = (
  agent: CallingAgent | undefined,
  sectionTitle: string
): AuthorizationDecision => {
  if (!agent) return { action: 'allow' };
  const forbidden = agent.forbiddenSections ?? [];
  if (forbidden.includes(sectionTitle)) {
    return {
      action: 'deny',
      reason: `section "${sectionTitle}" is in ${agent.name}'s forbiddenSections`
    };
  }
  const authorized = agent.authorizedSections;
  if (authorized === undefined || authorized.length === 0) return { action: 'allow' };
  if (authorized.includes(sectionTitle)) return { action: 'allow' };
  return {
    action: 'warn',
    reason: `section "${sectionTitle}" is outside ${agent.name}'s authorizedSections (soft boundary)`
  };
};

export interface UpdateStorySectionInput {
  readonly path: string;
  readonly sectionTitle: string;
  readonly content: string;
  readonly callingAgent?: CallingAgent;
  /** Override `updatedAt` ISO timestamp (for tests). */
  readonly now?: string;
}

export interface UpdateStorySectionOk {
  readonly path: string;
  readonly section: string;
  /** Present when authorization decided `warn`. The warning was logged
   * AND a soft-boundary line was appended to the story's Change Log. */
  readonly warning?: string;
}

const renderSection = (s: StorySection): string => `## ${s.title}\n\n${s.body.trim()}\n`;

const replaceSection = (
  story: Story,
  sectionTitle: string,
  newContent: string
): Result<readonly StorySection[], AtlasError> => {
  const idx = story.sections.findIndex((s) => s.title === sectionTitle);
  if (idx < 0) {
    return err(
      atlasError('STORY_SECTION_MISSING', `story ${story.path} has no section "${sectionTitle}"`)
    );
  }
  const next: StorySection[] = [...story.sections];
  next[idx] = { title: sectionTitle, body: newContent.trim() };
  return ok(next);
};

const appendChangeLogEntry = (
  sections: readonly StorySection[],
  entry: string
): readonly StorySection[] => {
  const idx = sections.findIndex((s) => s.title === 'Change Log');
  const line = `- ${entry}`;
  if (idx < 0) {
    return [...sections, { title: 'Change Log', body: line }];
  }
  const existing = sections[idx];
  if (!existing) return sections;
  const merged: StorySection = {
    title: 'Change Log',
    body: existing.body.length === 0 || existing.body === '_(empty)_' ? line : `${existing.body}\n${line}`
  };
  const next: StorySection[] = [...sections];
  next[idx] = merged;
  return next;
};

export const updateStorySection = async (
  input: UpdateStorySectionInput
): Promise<Result<UpdateStorySectionOk, AtlasError>> => {
  const decision = decideSectionAccess(input.callingAgent, input.sectionTitle);
  if (decision.action === 'deny') {
    return err(
      atlasError('STORY_SECTION_FORBIDDEN', decision.reason, {
        context: {
          path: input.path,
          section: input.sectionTitle,
          agent: input.callingAgent?.name
        }
      })
    );
  }

  let raw: string;
  try {
    raw = await readFile(input.path, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      return err(atlasError('STORY_NOT_FOUND', `no story at ${input.path}`));
    }
    return err(
      atlasError('STORY_PARSE_FAILED', `failed to read story ${input.path}`, { cause: e })
    );
  }

  const parsed = parseStory(raw, input.path);
  if (!parsed.ok) return parsed;
  const story = parsed.value;

  const replaced = replaceSection(story, input.sectionTitle, input.content);
  if (!replaced.ok) return replaced;

  const updatedAt = input.now ?? new Date().toISOString();
  const finalSections =
    decision.action === 'warn'
      ? appendChangeLogEntry(
          replaced.value,
          `${updatedAt} — ${input.callingAgent?.name ?? 'unknown'} updated "${input.sectionTitle}" (soft-boundary cross)`
        )
      : replaced.value;

  const fm: Record<string, unknown> = {
    ...story.frontmatter,
    updatedAt
  };
  // Re-validate so we never write a frontmatter that fails to parse on reload.
  const fmCheck = StoryFrontmatterSchema.safeParse(fm);
  if (!fmCheck.success) {
    return err(
      atlasError('STORY_PARSE_FAILED', `refused to write invalid frontmatter`, {
        context: { issues: fmCheck.error.issues }
      })
    );
  }

  const body = finalSections.map(renderSection).join('\n');
  const md = matter.stringify(`\n${body}`, fmCheck.data);

  try {
    const tmp = join(tmpdir(), `atlas-story-update-${Date.now()}.md`);
    await writeFile(tmp, md, 'utf8');
    await rename(tmp, input.path);
  } catch (e) {
    return err(
      atlasError('STORY_PARSE_FAILED', `failed to write story ${input.path}`, { cause: e })
    );
  }

  if (decision.action === 'warn') {
    return ok({ path: input.path, section: input.sectionTitle, warning: decision.reason });
  }
  return ok({ path: input.path, section: input.sectionTitle });
};
