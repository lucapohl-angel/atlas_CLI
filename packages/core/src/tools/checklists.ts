/**
 * `checklist_run` and `checklist_list` tools — model-callable wrappers
 * over the checklists engine. Owner enforcement reads `ctx.callingAgent`
 * so the active agent's identity is the only source of authority.
 *
 * The engine never decides pass/fail itself: the calling agent supplies
 * one status per item and the runner counts blockers and produces a
 * verdict. This keeps semantic judgement in the agent and structural
 * accounting in the engine.
 */
import { z } from 'zod';
import {
  findChecklist,
  loadChecklists,
  runChecklist,
  ChecklistItemResultSchema
} from '../checklists/index.js';
import { atlasError } from '../errors.js';
import { err, ok } from '../result.js';
import type { Tool } from './types.js';

const RunInput = z.object({
  checklistId: z.string().min(1),
  results: z.array(ChecklistItemResultSchema).min(1),
  /** Optional path of the artifact under review (e.g. `docs/prd.md`). */
  target: z.string().optional(),
  /** Optional override for checklists dir (mostly for tests). */
  dir: z.string().optional()
});

export const checklistRunTool: Tool<z.infer<typeof RunInput>> = {
  name: 'checklist_run',
  description:
    'Run an Atlas checklist by id with the agent-supplied per-item results. Returns a structured verdict.',
  approval: 'auto',
  schema: RunInput,
  whenToUse:
    'Use after producing or reviewing an artifact to gate the work before handoff. Call `checklist_list` first to discover ids, then call this with one `{itemId, status}` entry per declared item. The verdict is `pass` only when no blocker item failed.',
  outputContract:
    'On success, `summary` is `<verdict> <checklistId> v<version> (pass=<n> fail=<n> skip=<n> blockerFails=<n>)`. `data` carries `{checklistId, version, target, items, results, counts, verdict}`. Failure returns CHECKLIST_NOT_FOUND, CHECKLIST_PARSE_FAILED, CHECKLIST_OWNER_MISMATCH, or CHECKLIST_INPUT_INVALID.',
  blockedOps: [
    'running a checklist owned by another agent (refused unless caller is in `editors`)',
    'submitting results that omit declared items or reference unknown items'
  ],
  examples: [
    {
      input:
        '{"checklistId":"prd-ready","results":[{"itemId":"problem-stated","status":"pass"},{"itemId":"metrics-measurable","status":"fail","note":"two metrics lack targets"}]}',
      result: 'returns verdict "fail" with blockerFails=1'
    }
  ],
  async execute(input, ctx) {
    const find = await findChecklist(input.checklistId, {
      ...(input.dir ? { dir: input.dir } : {})
    });
    if (!find.ok) return err(find.error);
    const r = runChecklist({
      checklist: find.value,
      results: input.results,
      ...(input.target ? { target: input.target } : {}),
      ...(ctx.callingAgent ? { callingAgent: { name: ctx.callingAgent.name } } : {})
    });
    if (!r.ok) return err(r.error);
    const c = r.value.counts;
    return ok({
      type: 'ok',
      summary: `${r.value.verdict} ${r.value.checklistId} v${r.value.version} (pass=${c.pass} fail=${c.fail} skip=${c.skip} blockerFails=${c.blockerFails})`,
      data: r.value
    });
  }
};

const ListInput = z.object({
  dir: z.string().optional()
});

export const checklistListTool: Tool<z.infer<typeof ListInput>> = {
  name: 'checklist_list',
  description: 'List available Atlas checklists with their owners and item counts.',
  approval: 'auto',
  schema: ListInput,
  whenToUse:
    'Use to discover which checklist to run. Returns one entry per checklist id (newest version only).',
  outputContract:
    'On success, `summary` is `<n> checklist(s)`. `data.checklists` is an array of `{id, version, title, owner?, appliesTo?, itemCount}`.',
  examples: [{ input: '{}', result: 'lists all installed checklists' }],
  async execute(input) {
    const r = await loadChecklists({ ...(input.dir ? { dir: input.dir } : {}) });
    if (!r.ok) return err(r.error);
    const items = r.value.map((c) => ({
      id: c.id,
      version: c.version,
      title: c.title,
      ...(c.owner ? { owner: c.owner } : {}),
      ...(c.appliesTo ? { appliesTo: c.appliesTo } : {}),
      itemCount: c.items.length
    }));
    if (items.length === 0) {
      return err(atlasError('CHECKLIST_NOT_FOUND', 'no checklists installed'));
    }
    return ok({
      type: 'ok',
      summary: `${items.length} checklist(s)`,
      data: { checklists: items }
    });
  }
};
