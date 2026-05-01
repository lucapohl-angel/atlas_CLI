/**
 * `template_render` tool — model-callable wrapper over the templates
 * engine. Owner enforcement reads `ctx.callingAgent` so the active
 * agent's identity is the only source of authority — the model cannot
 * lie about who it is.
 *
 * The rendered Markdown is returned in `data.content` for the caller
 * (or the model) to write through `write_file` or `story_update` so
 * the mixed-mode authorization on per-section writes still applies.
 */
import { z } from 'zod';
import { atlasError } from '../errors.js';
import { err, ok } from '../result.js';
import { findTemplate, loadTemplates, renderTemplate } from '../templates/index.js';
import type { Tool } from './types.js';

const RenderInput = z.object({
  templateId: z.string().min(1),
  inputs: z.record(z.unknown()).default({}),
  /** Optional override for templates dir (mostly for tests). */
  dir: z.string().optional()
});

export const templateRenderTool: Tool<z.infer<typeof RenderInput>> = {
  name: 'template_render',
  description:
    'Render an Atlas template by id with the given inputs. Enforces owner and elicitation rules.',
  approval: 'auto',
  schema: RenderInput,
  whenToUse:
    'Use to draft a structured artifact (PRD, architecture, story, etc.) instead of free-form Markdown. The template enforces section ownership, elicitation gates, and conditional / repeatable structure so the output is consistent across runs and across agents. Pair with `write_file` or `story_update` to persist.',
  outputContract:
    'On success, `summary` is `rendered <templateId> v<version>`. `data` carries `{templateId, version, content, elicited}`. Failure returns TEMPLATE_NOT_FOUND, TEMPLATE_PARSE_FAILED, TEMPLATE_OWNER_MISMATCH, TEMPLATE_INPUT_MISSING, or TEMPLATE_RENDER_FAILED.',
  blockedOps: [
    'rendering a template owned by another agent (refused unless the calling agent is in `editors`)',
    'rendering an `elicit: true` section without first collecting the referenced inputs (refused with TEMPLATE_INPUT_MISSING)'
  ],
  examples: [
    {
      input: '{"templateId":"prd","inputs":{"project_name":"Atlas","problem_statement":"…","users":["devs"]}}',
      result: 'returns the rendered PRD content; caller writes it to docs/prd.md'
    }
  ],
  async execute(input, ctx) {
    const find = await findTemplate(input.templateId, {
      ...(input.dir ? { dir: input.dir } : {})
    });
    if (!find.ok) return err(find.error);
    const r = renderTemplate({
      template: find.value,
      inputs: input.inputs,
      ...(ctx.callingAgent ? { callingAgent: { name: ctx.callingAgent.name } } : {})
    });
    if (!r.ok) return err(r.error);
    return ok({
      type: 'ok',
      summary: `rendered ${r.value.templateId} v${r.value.version}`,
      data: r.value
    });
  }
};

const ListInput = z.object({
  dir: z.string().optional()
});

export const templateListTool: Tool<z.infer<typeof ListInput>> = {
  name: 'template_list',
  description: 'List available Atlas templates with their owners and outputs.',
  approval: 'auto',
  schema: ListInput,
  whenToUse:
    'Use when an agent needs to discover which template to render. Returns one entry per template id (newest version only).',
  outputContract:
    'On success, `summary` is `<n> template(s)`. `data.templates` is an array of `{id, version, title, owner?, output?}`.',
  examples: [
    { input: '{}', result: 'lists all installed templates' }
  ],
  async execute(input) {
    const r = await loadTemplates({ ...(input.dir ? { dir: input.dir } : {}) });
    if (!r.ok) return err(r.error);
    const items = r.value.map((t) => ({
      id: t.id,
      version: t.version,
      title: t.title,
      ...(t.owner ? { owner: t.owner } : {}),
      ...(t.output ? { output: t.output } : {})
    }));
    if (items.length === 0) {
      return err(atlasError('TEMPLATE_NOT_FOUND', 'no templates installed'));
    }
    return ok({
      type: 'ok',
      summary: `${items.length} template(s)`,
      data: { templates: items }
    });
  }
};
