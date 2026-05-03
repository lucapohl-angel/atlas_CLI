/**
 * `recommendNext` — orchestrator entrypoint that combines three signals:
 *
 *   1. The pending handoff queue (`docs/.handoffs/`). Oldest unconsumed
 *      handoff wins. This makes explicit `handoff_emit` calls authoritative.
 *   2. The chain table loaded from `chains.yaml`. Used when a `fromAgent`
 *      and (optionally) `command` are supplied by the caller.
 *   3. The static state-based fallback (`recommendAgent`). Used when no
 *      handoff is pending and no chain matches.
 *
 * The result discriminates on `source` so the CLI can show the user *why*
 * the orchestrator picked a particular next step.
 */
import { listHandoffs } from '../stories/handoff.js';
import { detectProjectState, recommendAgent } from '../orchestrator/index.js';
import { loadProjectState } from '../state/index.js';
import type { AtlasError } from '../errors.js';
import type { Result } from '../result.js';
import { ok } from '../result.js';
import { loadWorkflowConfig, type LoadChainsOptions } from './loader.js';
import type { ChainRequires, ChainStep, WorkflowActivation } from './types.js';

export type NextSource = 'handoff' | 'chain' | 'state' | 'state-file';

export interface NextRecommendation {
  readonly source: NextSource;
  readonly agent: string;
  readonly reason: string;
  readonly command?: string;
  readonly handoffPath?: string;
  readonly storyId?: string;
  readonly activation?: WorkflowActivation;
}

export interface RecommendNextOptions extends LoadChainsOptions {
  readonly cwd?: string;
  readonly fromAgent?: string;
  readonly lastCommand?: string;
}

const requiresSatisfied = async (
  cwd: string,
  requires: ChainRequires | undefined
): Promise<boolean> => {
  if (!requires) return true;
  const detected = await detectProjectState(cwd);

  if (requires.hasPRD !== undefined && detected.hasPRD !== requires.hasPRD) return false;
  if (requires.hasArchitecture !== undefined && detected.hasArchitecture !== requires.hasArchitecture) return false;
  if (requires.hasStories !== undefined && detected.hasStories !== requires.hasStories) return false;
  if (requires.hasContextPack !== undefined && detected.hasContextPack !== requires.hasContextPack) return false;
  if (requires.minStories !== undefined && detected.storyCount < requires.minStories) return false;

  if (requires.storyStatus || (requires.artifact && requires.status)) {
    const stateR = await loadProjectState({ cwd });
    if (!stateR.ok) return false;
    if (requires.storyStatus) {
      if (!stateR.value.stories.some((s) => s.status === requires.storyStatus)) return false;
    }
    if (requires.artifact && requires.status) {
      const cur = stateR.value.artifacts[requires.artifact]?.status ?? 'missing';
      if (cur !== requires.status) return false;
    }
  }
  return true;
};

const pickEligibleChainStep = async (
  cwd: string,
  chains: readonly ChainStep[],
  fromAgent: string,
  command?: string
): Promise<ChainStep | undefined> => {
  // Iterate ALL exact matches in declaration order (not just the first
  // via lookupChain) so a chain author can stack multiple entries for
  // the same (fromAgent, command) pair where the first eligible
  // `requires` block wins. This is what enables conditional routing
  // like "if hasContextPack=false → scaffold first, otherwise proceed
  // to the normal next step".
  for (const step of chains) {
    if (step.fromAgent !== fromAgent) continue;
    if (step.command !== command) continue;
    if (await requiresSatisfied(cwd, step.requires)) return step;
  }
  const wildcards = chains.filter((c) => c.fromAgent === fromAgent && c.command === undefined);
  for (const step of wildcards) {
    if (await requiresSatisfied(cwd, step.requires)) return step;
  }
  return undefined;
};

export const recommendNext = async (
  opts: RecommendNextOptions = {}
): Promise<Result<NextRecommendation, AtlasError>> => {
  const cwd = opts.cwd ?? process.cwd();

  const handoffsR = await listHandoffs({ cwd });
  if (!handoffsR.ok) return handoffsR;
  const workflowR = await loadWorkflowConfig(opts);
  if (!workflowR.ok) return workflowR;
  const activation = workflowR.value.activation;

  const oldest = handoffsR.value[0];
  if (oldest) {
    const rec: NextRecommendation = {
      source: 'handoff',
      agent: oldest.handoff.toAgent,
      reason: `pending handoff from ${oldest.handoff.fromAgent}`,
      handoffPath: oldest.path,
      ...(activation ? { activation } : {}),
      ...(oldest.handoff.command !== undefined ? { command: oldest.handoff.command } : {}),
      ...(oldest.handoff.storyId !== undefined ? { storyId: oldest.handoff.storyId } : {})
    };
    return ok(rec);
  }

  if (opts.fromAgent) {
    const step = await pickEligibleChainStep(
      cwd,
      workflowR.value.chains,
      opts.fromAgent,
      opts.lastCommand
    );
    if (step) {
      const rec: NextRecommendation = {
        source: 'chain',
        agent: step.toAgent,
        reason: step.reason ?? `chain: ${step.fromAgent}${step.command ? ` ${step.command}` : ''} \u2192 ${step.toAgent}`,
        ...(activation ? { activation } : {}),
        ...(step.nextCommand !== undefined ? { command: step.nextCommand } : {})
      };
      return ok(rec);
    }

    const stateR = await loadProjectState({ cwd });
    if (stateR.ok) {
      const ready = stateR.value.stories.find((s) => s.status === 'ready-for-dev');
      if (ready) {
        return ok({
          source: 'state-file',
          agent: 'hercules',
          reason: `story ${ready.id} is ready-for-dev in .atlas/state.yaml`,
          storyId: ready.id,
          ...(activation ? { activation } : {})
        });
      }
    }
  }

  const state = await detectProjectState(cwd);
  const rec = recommendAgent(state);
  return ok({ source: 'state', agent: rec.agent, reason: rec.reason, ...(activation ? { activation } : {}) });
};
