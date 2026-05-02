/**
 * Wave grouping for the slice-3 plan executor.
 *
 * Given a validated Plan (no cycles, no unknown deps — checkPlan
 * already enforced these), `groupIntoWaves` returns an ordered list
 * of waves where each wave is a set of tasks whose dependencies have
 * all completed by the previous wave. Tasks within a wave can run in
 * parallel; waves run sequentially.
 *
 * Algorithm: Kahn's topological sort, batched by dependency depth.
 */
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type { Plan, PlanTask } from './plan.js';

export type Wave = readonly PlanTask[];

export const groupIntoWaves = (plan: Plan): Result<readonly Wave[], AtlasError> => {
  const byId = new Map<string, PlanTask>();
  for (const t of plan.tasks) {
    if (byId.has(t.id)) {
      return err(atlasError('WORKFLOW_INVALID_TRANSITION', `duplicate task id ${t.id} in plan`));
    }
    byId.set(t.id, t);
  }

  const remaining = new Map<string, Set<string>>();
  for (const t of plan.tasks) remaining.set(t.id, new Set(t.deps));

  const waves: PlanTask[][] = [];
  const completed = new Set<string>();

  while (completed.size < plan.tasks.length) {
    const wave: PlanTask[] = [];
    for (const t of plan.tasks) {
      if (completed.has(t.id)) continue;
      const deps = remaining.get(t.id)!;
      if (deps.size === 0) wave.push(t);
    }
    if (wave.length === 0) {
      // Plan was supposed to be cycle-free; if we land here something
      // changed between checkPlan and this call.
      return err(
        atlasError(
          'WORKFLOW_INVALID_TRANSITION',
          'cannot make progress: cycle or unsatisfiable dep in plan'
        )
      );
    }
    for (const t of wave) {
      completed.add(t.id);
      for (const t2 of plan.tasks) remaining.get(t2.id)!.delete(t.id);
    }
    waves.push(wave);
  }

  return ok(waves);
};
