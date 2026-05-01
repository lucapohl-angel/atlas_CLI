/**
 * Checklist runner — aggregates agent verdicts into a structured report.
 * The engine never decides pass/fail itself; the agent supplies one
 * status per item and the runner counts blockers and produces a verdict.
 */
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type {
  Checklist,
  ChecklistItemResult,
  ChecklistRunResult
} from './types.js';

export interface RunChecklistOptions {
  readonly checklist: Checklist;
  readonly results: readonly ChecklistItemResult[];
  readonly target?: string;
  readonly callingAgent?: { readonly name: string } | undefined;
}

export const runChecklist = (
  opts: RunChecklistOptions
): Result<ChecklistRunResult, AtlasError> => {
  const { checklist, results, target, callingAgent } = opts;

  // Owner gate (mirrors templates).
  if (checklist.owner && callingAgent) {
    const allowed =
      callingAgent.name === checklist.owner ||
      (checklist.editors?.includes(callingAgent.name) ?? false);
    if (!allowed) {
      return err(
        atlasError(
          'CHECKLIST_OWNER_MISMATCH',
          `agent "${callingAgent.name}" is not allowed to run checklist "${checklist.id}" (owner: ${checklist.owner})`
        )
      );
    }
  }

  // Every declared item must have exactly one result.
  const byId = new Map<string, ChecklistItemResult>();
  for (const r of results) {
    if (byId.has(r.itemId)) {
      return err(
        atlasError(
          'CHECKLIST_INPUT_INVALID',
          `duplicate result for item "${r.itemId}"`
        )
      );
    }
    byId.set(r.itemId, r);
  }

  const declared = new Set(checklist.items.map((i) => i.id));
  for (const id of byId.keys()) {
    if (!declared.has(id)) {
      return err(
        atlasError(
          'CHECKLIST_INPUT_INVALID',
          `result references unknown item "${id}"`
        )
      );
    }
  }

  const ordered: ChecklistItemResult[] = [];
  const missing: string[] = [];
  for (const item of checklist.items) {
    const r = byId.get(item.id);
    if (!r) {
      missing.push(item.id);
      continue;
    }
    ordered.push(r);
  }
  if (missing.length > 0) {
    return err(
      atlasError(
        'CHECKLIST_INPUT_INVALID',
        `missing result(s) for: ${missing.join(', ')}`
      )
    );
  }

  let pass = 0;
  let fail = 0;
  let skip = 0;
  let blockerFails = 0;
  let warningFails = 0;
  for (let i = 0; i < checklist.items.length; i++) {
    const item = checklist.items[i]!;
    const r = ordered[i]!;
    if (r.status === 'pass') pass++;
    else if (r.status === 'skip') skip++;
    else {
      fail++;
      if (item.severity === 'blocker') blockerFails++;
      else if (item.severity === 'warning') warningFails++;
    }
  }

  return ok({
    checklistId: checklist.id,
    version: checklist.version,
    target,
    items: checklist.items,
    results: ordered,
    counts: { pass, fail, skip, blockerFails, warningFails },
    verdict: blockerFails === 0 ? 'pass' : 'fail'
  });
};
