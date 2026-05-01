/**
 * Story + handoff tools. Thin wrappers over `@atlas/core/stories`
 * primitives so the model can drive them through the standard tool
 * call channel. `story_update` consults `ctx.callingAgent` to apply
 * the mixed-mode authorization model: hard-fail on forbiddenSections,
 * warn-and-write on unauthorized-but-not-forbidden, allow on
 * authorizedSections.
 */
import { z } from 'zod';
import { atlasError } from '../errors.js';
import { err, ok } from '../result.js';
import {
  consumeHandoff,
  createStory,
  emitHandoff,
  listHandoffs,
  updateStorySection
} from '../stories/index.js';
import type { Tool } from './types.js';

const StoryCreateInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  agent: z.string().optional(),
  epic: z.string().optional(),
  status: z.enum(['draft', 'ready', 'in-progress', 'in-review', 'done', 'blocked']).optional(),
  links: z
    .object({
      prd: z.string().optional(),
      architecture: z.string().optional(),
      uxSpec: z.string().optional()
    })
    .partial()
    .optional(),
  force: z.boolean().default(false)
});

export const storyCreateTool: Tool<z.infer<typeof StoryCreateInput>> = {
  name: 'story_create',
  description:
    'Scaffold a new story file at docs/stories/<id>.md with the standard 12 H2 sections.',
  approval: 'ask',
  schema: StoryCreateInput,
  whenToUse:
    'Use when the SM (Hestia) is breaking down an epic and needs to start a new story. Once created, individual sections are populated via `story_update`. The 12 default sections (Problem, Users, Goals, Non-Goals, Architecture, Tech Stack, Tasks, Implementation Notes, Test Strategy, QA Notes, Release Notes, Change Log) line up with the per-agent authorizedSections, so the mixed-mode authorization in `story_update` works out of the box.',
  outputContract:
    'On success, `summary` is `created docs/stories/<slug>.md`. `data` carries `{path}`. Failure returns STORY_PARSE_FAILED.',
  blockedOps: [
    'overwriting an existing story without `force: true` (refused)'
  ],
  examples: [
    {
      input: '{"id":"login-flow","title":"Login flow","agent":"hercules","epic":"auth"}',
      result: 'creates docs/stories/login-flow.md with empty sections'
    }
  ],
  async execute(input, ctx) {
    const r = await createStory({
      id: input.id,
      title: input.title,
      cwd: ctx.cwd,
      force: input.force,
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.epic !== undefined ? { epic: input.epic } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.links !== undefined ? { links: input.links } : {})
    });
    if (!r.ok) return err(r.error);
    return ok({ type: 'ok', summary: `created ${r.value.path}`, data: { path: r.value.path } });
  }
};

const StoryUpdateInput = z.object({
  path: z.string().min(1),
  sectionTitle: z.string().min(1),
  content: z.string()
});

export const storyUpdateTool: Tool<z.infer<typeof StoryUpdateInput>> = {
  name: 'story_update',
  description:
    'Replace the body of one H2 section in a story file. Enforces per-agent authorizedSections / forbiddenSections.',
  approval: 'ask',
  schema: StoryUpdateInput,
  whenToUse:
    'Use to write or rewrite a single named H2 section of an existing story. The calling agent\'s authorizedSections / forbiddenSections (declared on its AGENT.md frontmatter) drive a mixed-mode access check: hard-fail on forbiddenSections, allow on authorizedSections, warn-and-write outside both (with a soft-boundary line appended to the story\'s Change Log for audit).',
  outputContract:
    'On success, `summary` is `updated <section> in <path>` (or `updated <section> in <path> [warning: ...]` when the soft boundary was crossed). `data` carries `{path, section, warning?}`. Failure returns STORY_SECTION_FORBIDDEN, STORY_SECTION_MISSING, STORY_NOT_FOUND, or STORY_PARSE_FAILED.',
  blockedOps: [
    'editing a section listed in the calling agent\'s forbiddenSections (refused)',
    'editing a section that does not exist in the story (refused)'
  ],
  examples: [
    {
      input: '{"path":"docs/stories/login-flow.md","sectionTitle":"Tasks","content":"- [ ] wire form\\n- [ ] add tests"}',
      result: 'replaces the Tasks section body and bumps updatedAt'
    },
    {
      input: '{"path":"docs/stories/login-flow.md","sectionTitle":"Goals","content":"sneak"}',
      result: 'rejected if the calling agent has Goals in forbiddenSections',
      note: 'Use the proper handoff to the owning agent instead of forcing the edit.'
    }
  ],
  async execute(input, ctx) {
    const r = await updateStorySection({
      path: input.path,
      sectionTitle: input.sectionTitle,
      content: input.content,
      ...(ctx.callingAgent ? { callingAgent: ctx.callingAgent } : {})
    });
    if (!r.ok) return err(r.error);
    const summary = r.value.warning
      ? `updated ${r.value.section} in ${r.value.path} [warning: ${r.value.warning}]`
      : `updated ${r.value.section} in ${r.value.path}`;
    return ok({ type: 'ok', summary, data: r.value });
  }
};

const HandoffEmitInput = z.object({
  fromAgent: z.string().min(1),
  toAgent: z.string().min(1),
  storyId: z.string().optional(),
  command: z.string().optional(),
  payload: z.record(z.unknown()).optional()
});

export const handoffEmitTool: Tool<z.infer<typeof HandoffEmitInput>> = {
  name: 'handoff_emit',
  description: 'Drop a typed handoff message under docs/.handoffs/ for the next agent to consume.',
  approval: 'auto',
  schema: HandoffEmitInput,
  whenToUse:
    'Use at the end of an agent\'s turn to announce that the next phase is ready. The receiving agent (or the orchestrator on `*next`) picks the message up via `handoff_consume`. Cheap and ordered by createdAt.',
  outputContract:
    'On success, `summary` is `emitted handoff <from> → <to>`. `data` carries `{path, handoff}`. Failure returns HANDOFF_PARSE_FAILED.',
  examples: [
    {
      input: '{"fromAgent":"athena","toAgent":"prometheus","storyId":"login-flow","command":"write-architecture","payload":{"note":"PRD ready"}}',
      result: 'writes a fresh handoff file with consumed:false'
    }
  ],
  async execute(input, ctx) {
    const r = await emitHandoff({
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      cwd: ctx.cwd,
      ...(input.storyId !== undefined ? { storyId: input.storyId } : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {})
    });
    if (!r.ok) return err(r.error);
    return ok({
      type: 'ok',
      summary: `emitted handoff ${r.value.handoff.fromAgent} \u2192 ${r.value.handoff.toAgent}`,
      data: { path: r.value.path, handoff: r.value.handoff }
    });
  }
};

const HandoffConsumeInput = z
  .object({
    path: z.string().optional(),
    toAgent: z.string().optional()
  })
  .refine((v) => v.path !== undefined || v.toAgent !== undefined, {
    message: 'pass either `path` (specific handoff) or `toAgent` (oldest pending for that agent)'
  });

export const handoffConsumeTool: Tool<z.infer<typeof HandoffConsumeInput>> = {
  name: 'handoff_consume',
  description: 'Mark the oldest pending handoff for an agent (or a specific path) as consumed.',
  approval: 'auto',
  schema: HandoffConsumeInput,
  whenToUse:
    'Use when an agent starts its turn and wants to know what was passed to it. Pass `toAgent` to consume the oldest pending message addressed to that agent, or `path` to consume a specific file. Returns the payload.',
  outputContract:
    'On success, `summary` is `consumed handoff <from> → <to>`. `data` carries the full handoff object. Failure returns HANDOFF_NOT_FOUND or HANDOFF_PARSE_FAILED.',
  examples: [
    {
      input: '{"toAgent":"prometheus"}',
      result: 'consumes the oldest pending handoff addressed to prometheus'
    }
  ],
  async execute(input, ctx) {
    let path = input.path;
    if (path === undefined) {
      const list = await listHandoffs({
        cwd: ctx.cwd,
        ...(input.toAgent !== undefined ? { toAgent: input.toAgent } : {})
      });
      if (!list.ok) return err(list.error);
      const oldest = list.value[0];
      if (!oldest) {
        return err(
          atlasError('HANDOFF_NOT_FOUND', `no pending handoff${input.toAgent ? ` for ${input.toAgent}` : ''}`)
        );
      }
      path = oldest.path;
    }
    const r = await consumeHandoff(path);
    if (!r.ok) return err(r.error);
    return ok({
      type: 'ok',
      summary: `consumed handoff ${r.value.fromAgent} \u2192 ${r.value.toAgent}`,
      data: r.value
    });
  }
};
