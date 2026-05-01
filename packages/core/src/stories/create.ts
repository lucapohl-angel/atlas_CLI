/**
 * Story scaffolding. Writes a new `docs/stories/<id>.md` with the
 * standard SDD section layout. Each section header lines up with one
 * agent's `authorizedSections` so the mixed-mode authorization in
 * `update.ts` works out of the box.
 *
 * Atomic via tmpfile + rename. Refuses to overwrite an existing file
 * unless `force: true` is passed.
 */
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import matter from 'gray-matter';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import { StoryFrontmatterSchema, type StoryStatus } from './types.js';

/** Slugify a story id: lowercase, alnum + dashes, max 60 chars. */
export const slugifyStoryId = (raw: string): string => {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'story';
};

export interface CreateStoryInput {
  readonly id: string;
  readonly title: string;
  readonly agent?: string;
  readonly epic?: string;
  readonly status?: StoryStatus;
  readonly links?: { readonly prd?: string; readonly architecture?: string; readonly uxSpec?: string };
  /** Override target dir (defaults to `<cwd>/docs/stories`). */
  readonly dir?: string;
  /** Override current working directory used to resolve the default dir. */
  readonly cwd?: string;
  /** Override `createdAt` ISO timestamp (for tests). */
  readonly now?: string;
  /** Overwrite an existing story at the same path. */
  readonly force?: boolean;
}

/**
 * Default H2 sections written into a fresh story file. The order and
 * titles match the `authorizedSections` declared on the framework
 * agents; do not rename casually.
 */
export const DEFAULT_STORY_SECTIONS: readonly string[] = [
  'Problem',
  'Users',
  'Goals',
  'Non-Goals',
  'Architecture',
  'Tech Stack',
  'Tasks',
  'Implementation Notes',
  'Test Strategy',
  'QA Notes',
  'Release Notes',
  'Change Log'
];

export const renderStoryScaffold = (input: CreateStoryInput, createdAt: string): string => {
  const fm: Record<string, unknown> = {
    id: input.id,
    title: input.title,
    status: input.status ?? 'draft',
    createdAt,
    updatedAt: createdAt
  };
  if (input.agent !== undefined) fm.agent = input.agent;
  if (input.epic !== undefined) fm.epic = input.epic;
  if (input.links !== undefined) fm.links = { ...input.links };
  const body = DEFAULT_STORY_SECTIONS.map((title) => `## ${title}\n\n_(empty)_\n`).join('\n');
  return matter.stringify(`\n${body}`, fm);
};

export const createStory = async (
  input: CreateStoryInput
): Promise<Result<{ readonly path: string }, AtlasError>> => {
  const fmCheck = StoryFrontmatterSchema.safeParse({
    id: input.id,
    title: input.title,
    status: input.status ?? 'draft'
  });
  if (!fmCheck.success) {
    return err(
      atlasError('STORY_PARSE_FAILED', `invalid story input`, {
        context: { issues: fmCheck.error.issues }
      })
    );
  }
  const cwd = input.cwd ?? process.cwd();
  const dir = input.dir ?? join(cwd, 'docs', 'stories');
  const slug = slugifyStoryId(input.id);
  const target = join(dir, `${slug}.md`);
  if (!input.force) {
    try {
      await stat(target);
      return err(atlasError('STORY_PARSE_FAILED', `story already exists at ${target}`));
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') {
        return err(atlasError('STORY_PARSE_FAILED', `cannot stat ${target}`, { cause: e }));
      }
    }
  }
  const createdAt = input.now ?? new Date().toISOString();
  const md = renderStoryScaffold(input, createdAt);
  try {
    await mkdir(dirname(target), { recursive: true });
    const tmp = join(tmpdir(), `atlas-story-create-${slug}-${Date.now()}.md`);
    await writeFile(tmp, md, 'utf8');
    await rename(tmp, target);
  } catch (e) {
    return err(atlasError('STORY_PARSE_FAILED', `failed to write story ${target}`, { cause: e }));
  }
  return ok({ path: target });
};
