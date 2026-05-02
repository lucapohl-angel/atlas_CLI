/**
 * Project state — a single shared YAML file at `<cwd>/.atlas/state.yaml`
 * that tracks epic/story status across the SDD pipeline. Analogue of
 * BMAD's `sprint-status.yaml`, but typed end-to-end.
 *
 * Used by:
 *   - The orchestrator (`recommendNext`) to gate chain transitions on
 *     artifact state (Phase 10).
 *   - Hercules (`*implement`) to find the next ready story.
 *   - Hestia (`*write-story`) to record new stories as `draft`.
 *   - Nemesis (`*qa-review`) to flip `review → done` (or back to
 *     `in-progress` on failure).
 *
 * The file is YAML so a human can edit it. It is NOT the source of
 * truth for the artifacts themselves — it is a status overlay. The
 * artifacts live under `docs/` (the PRD, architecture, story files);
 * this file just records *where each one is in the pipeline*.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';

const Identifier = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'use kebab-case identifiers (digits, dots, dashes ok)');

export const EpicStatusSchema = z.enum(['backlog', 'in-progress', 'done']);
export type EpicStatus = z.infer<typeof EpicStatusSchema>;

export const ProjectArtifactKeySchema = z.enum([
  'brief',
  'prd',
  'architecture',
  'ux-spec',
  'design-system',
  'epics'
]);
export type ProjectArtifactKey = z.infer<typeof ProjectArtifactKeySchema>;

export const ProjectArtifactStatusSchema = z.enum(['missing', 'draft', 'ready', 'done']);
export type ProjectArtifactStatus = z.infer<typeof ProjectArtifactStatusSchema>;

export const ProjectStoryStatusSchema = z.enum([
  'draft',
  'ready-for-dev',
  'in-progress',
  'review',
  'done',
  'blocked'
]);
export type ProjectStoryStatus = z.infer<typeof ProjectStoryStatusSchema>;

export const EpicEntrySchema = z.object({
  id: Identifier,
  title: z.string().min(1),
  status: EpicStatusSchema.default('backlog'),
  lastUpdated: z.string().optional()
});
export type EpicEntry = z.infer<typeof EpicEntrySchema>;

export const StoryEntrySchema = z.object({
  id: Identifier,
  title: z.string().min(1),
  status: ProjectStoryStatusSchema.default('draft'),
  epicId: Identifier.optional(),
  /** Free-form short owner label (agent name or GitHub handle). */
  owner: z.string().optional(),
  lastUpdated: z.string().optional(),
  /** Optional path to the story markdown file (cwd-relative). */
  path: z.string().optional()
});
export type StoryEntry = z.infer<typeof StoryEntrySchema>;

export const ArtifactEntrySchema = z.object({
  status: ProjectArtifactStatusSchema.default('missing'),
  owner: z.string().optional(),
  lastUpdated: z.string().optional()
});
export type ArtifactEntry = z.infer<typeof ArtifactEntrySchema>;

export const ProjectStateSchema = z.object({
  version: z.number().int().positive().default(1),
  artifacts: z.record(ProjectArtifactKeySchema, ArtifactEntrySchema).default({}),
  epics: z.array(EpicEntrySchema).default([]),
  stories: z.array(StoryEntrySchema).default([])
});
export type ProjectStateFile = z.infer<typeof ProjectStateSchema>;

export interface ProjectStateOptions {
  readonly cwd?: string;
  /** Override the default `<cwd>/.atlas/state.yaml` location. */
  readonly path?: string;
}

const STATE_REL_PATH = join('.atlas', 'state.yaml');

const resolveStatePath = (opts: ProjectStateOptions): string =>
  opts.path ?? join(opts.cwd ?? process.cwd(), STATE_REL_PATH);

const emptyState = (): ProjectStateFile => ({ version: 1, artifacts: {}, epics: [], stories: [] });

export const parseProjectState = (
  raw: string,
  path: string
): Result<ProjectStateFile, AtlasError> => {
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (e) {
    return err(
      atlasError('STATE_PARSE_FAILED', `failed to parse YAML at ${path}`, { cause: e })
    );
  }
  // An empty file is a legal empty state.
  if (data === null || data === undefined) return ok(emptyState());

  const parsed = ProjectStateSchema.safeParse(data);
  if (!parsed.success) {
    return err(
      atlasError(
        'STATE_PARSE_FAILED',
        `invalid state at ${path}: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`
      )
    );
  }
  return ok(parsed.data);
};

export const loadProjectState = async (
  opts: ProjectStateOptions = {}
): Promise<Result<ProjectStateFile, AtlasError>> => {
  const path = resolveStatePath(opts);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return ok(emptyState());
    return err(
      atlasError('STATE_PARSE_FAILED', `failed to read ${path}`, { cause: e })
    );
  }
  return parseProjectState(raw, path);
};

export const saveProjectState = async (
  state: ProjectStateFile,
  opts: ProjectStateOptions = {}
): Promise<Result<{ readonly path: string }, AtlasError>> => {
  const validated = ProjectStateSchema.safeParse(state);
  if (!validated.success) {
    return err(
      atlasError(
        'STATE_WRITE_FAILED',
        `refusing to write invalid state: ${validated.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`
      )
    );
  }
  const path = resolveStatePath(opts);
  const yaml =
    `# Atlas project state. Edit by hand if you need to.\n` +
    `# Maintained by Hestia (stories), Hercules (in-progress / review),\n` +
    `# Nemesis (review / done / blocked), and Hermes (epics).\n` +
    stringifyYaml(validated.data);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, yaml, 'utf8');
  } catch (e) {
    return err(
      atlasError('STATE_WRITE_FAILED', `failed to write ${path}`, { cause: e, context: { path } })
    );
  }
  return ok({ path });
};

const isoNow = (): string => new Date().toISOString();

const upsert = <T extends { readonly id: string }>(
  list: readonly T[],
  entry: T
): T[] => {
  const idx = list.findIndex((e) => e.id === entry.id);
  if (idx === -1) return [...list, entry];
  const next = [...list];
  next[idx] = entry;
  return next;
};

export interface UpsertEpicOptions extends ProjectStateOptions {
  readonly epic: Omit<EpicEntry, 'lastUpdated'>;
}

export const upsertEpic = async (
  opts: UpsertEpicOptions
): Promise<Result<EpicEntry, AtlasError>> => {
  const stateR = await loadProjectState(opts);
  if (!stateR.ok) return stateR;
  const next: EpicEntry = { ...opts.epic, lastUpdated: isoNow() };
  const updated: ProjectStateFile = {
    ...stateR.value,
    epics: upsert(stateR.value.epics, next)
  };
  const saveR = await saveProjectState(updated, opts);
  if (!saveR.ok) return err(saveR.error);
  return ok(next);
};

export interface UpsertStoryOptions extends ProjectStateOptions {
  readonly story: Omit<StoryEntry, 'lastUpdated'>;
}

export const upsertStory = async (
  opts: UpsertStoryOptions
): Promise<Result<StoryEntry, AtlasError>> => {
  const stateR = await loadProjectState(opts);
  if (!stateR.ok) return stateR;
  const next: StoryEntry = { ...opts.story, lastUpdated: isoNow() };
  const updated: ProjectStateFile = {
    ...stateR.value,
    stories: upsert(stateR.value.stories, next)
  };
  const saveR = await saveProjectState(updated, opts);
  if (!saveR.ok) return err(saveR.error);
  return ok(next);
};

export interface SetStoryStatusOptions extends ProjectStateOptions {
  readonly storyId: string;
  readonly status: ProjectStoryStatus;
}

export const setStoryStatus = async (
  opts: SetStoryStatusOptions
): Promise<Result<StoryEntry, AtlasError>> => {
  const stateR = await loadProjectState(opts);
  if (!stateR.ok) return stateR;
  const idx = stateR.value.stories.findIndex((s) => s.id === opts.storyId);
  if (idx === -1) {
    return err(
      atlasError(
        'STATE_STORY_NOT_FOUND',
        `no story "${opts.storyId}" in project state`,
        { context: { storyId: opts.storyId } }
      )
    );
  }
  const stories = [...stateR.value.stories];
  const before = stories[idx]!;
  const next: StoryEntry = { ...before, status: opts.status, lastUpdated: isoNow() };
  stories[idx] = next;
  const saveR = await saveProjectState({ ...stateR.value, stories }, opts);
  if (!saveR.ok) return err(saveR.error);
  return ok(next);
};

export interface SetEpicStatusOptions extends ProjectStateOptions {
  readonly epicId: string;
  readonly status: EpicStatus;
}

export interface SetArtifactStatusOptions extends ProjectStateOptions {
  readonly artifact: ProjectArtifactKey;
  readonly status: ProjectArtifactStatus;
  readonly owner?: string;
}

export const setEpicStatus = async (
  opts: SetEpicStatusOptions
): Promise<Result<EpicEntry, AtlasError>> => {
  const stateR = await loadProjectState(opts);
  if (!stateR.ok) return stateR;
  const idx = stateR.value.epics.findIndex((e) => e.id === opts.epicId);
  if (idx === -1) {
    return err(
      atlasError(
        'STATE_EPIC_NOT_FOUND',
        `no epic "${opts.epicId}" in project state`,
        { context: { epicId: opts.epicId } }
      )
    );
  }
  const epics = [...stateR.value.epics];
  const before = epics[idx]!;
  const next: EpicEntry = { ...before, status: opts.status, lastUpdated: isoNow() };
  epics[idx] = next;
  const saveR = await saveProjectState({ ...stateR.value, epics }, opts);
  if (!saveR.ok) return err(saveR.error);
  return ok(next);
};

export const setArtifactStatus = async (
  opts: SetArtifactStatusOptions
): Promise<Result<ArtifactEntry, AtlasError>> => {
  const stateR = await loadProjectState(opts);
  if (!stateR.ok) return stateR;
  const next: ArtifactEntry = {
    ...(stateR.value.artifacts[opts.artifact] ?? { status: 'missing' as const }),
    status: opts.status,
    ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
    lastUpdated: isoNow()
  };
  const saveR = await saveProjectState(
    {
      ...stateR.value,
      artifacts: {
        ...stateR.value.artifacts,
        [opts.artifact]: next
      }
    },
    opts
  );
  if (!saveR.ok) return err(saveR.error);
  return ok(next);
};

/**
 * Pure read-only query: the first story in the requested status,
 * preserving declaration order. Used by Hercules's `*implement` to
 * pick the next ready story.
 */
export const findFirstStoryByStatus = (
  state: ProjectStateFile,
  status: ProjectStoryStatus
): StoryEntry | undefined => state.stories.find((s) => s.status === status);

/**
 * Pure read-only summary: counts by status, useful for `atlas status`.
 */
export interface StateSummary {
  readonly stories: Readonly<Record<ProjectStoryStatus, number>>;
  readonly epics: Readonly<Record<EpicStatus, number>>;
  readonly totalStories: number;
  readonly totalEpics: number;
}

export const summarizeProjectState = (state: ProjectStateFile): StateSummary => {
  const stories: Record<ProjectStoryStatus, number> = {
    draft: 0,
    'ready-for-dev': 0,
    'in-progress': 0,
    review: 0,
    done: 0,
    blocked: 0
  };
  const epics: Record<EpicStatus, number> = { backlog: 0, 'in-progress': 0, done: 0 };
  for (const s of state.stories) stories[s.status]++;
  for (const e of state.epics) epics[e.status]++;
  return {
    stories,
    epics,
    totalStories: state.stories.length,
    totalEpics: state.epics.length
  };
};
