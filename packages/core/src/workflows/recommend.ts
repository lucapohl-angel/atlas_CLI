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
import type { AtlasError } from '../errors.js';
import type { Result } from '../result.js';
import { ok } from '../result.js';
import { loadChains, lookupChain, type LoadChainsOptions } from './loader.js';

export type NextSource = 'handoff' | 'chain' | 'state';

export interface NextRecommendation {
  readonly source: NextSource;
  readonly agent: string;
  readonly reason: string;
  readonly command?: string;
  readonly handoffPath?: string;
  readonly storyId?: string;
}

export interface RecommendNextOptions extends LoadChainsOptions {
  readonly cwd?: string;
  readonly fromAgent?: string;
  readonly lastCommand?: string;
}

export const recommendNext = async (
  opts: RecommendNextOptions = {}
): Promise<Result<NextRecommendation, AtlasError>> => {
  const cwd = opts.cwd ?? process.cwd();

  const handoffsR = await listHandoffs({ cwd });
  if (!handoffsR.ok) return handoffsR;
  const oldest = handoffsR.value[0];
  if (oldest) {
    const rec: NextRecommendation = {
      source: 'handoff',
      agent: oldest.handoff.toAgent,
      reason: `pending handoff from ${oldest.handoff.fromAgent}`,
      handoffPath: oldest.path,
      ...(oldest.handoff.command !== undefined ? { command: oldest.handoff.command } : {}),
      ...(oldest.handoff.storyId !== undefined ? { storyId: oldest.handoff.storyId } : {})
    };
    return ok(rec);
  }

  if (opts.fromAgent) {
    const chainsR = await loadChains(opts);
    if (!chainsR.ok) return chainsR;
    const step = lookupChain(chainsR.value, opts.fromAgent, opts.lastCommand);
    if (step) {
      const rec: NextRecommendation = {
        source: 'chain',
        agent: step.toAgent,
        reason: step.reason ?? `chain: ${step.fromAgent}${step.command ? ` ${step.command}` : ''} \u2192 ${step.toAgent}`,
        ...(step.nextCommand !== undefined ? { command: step.nextCommand } : {})
      };
      return ok(rec);
    }
  }

  const state = await detectProjectState(cwd);
  const rec = recommendAgent(state);
  return ok({ source: 'state', agent: rec.agent, reason: rec.reason });
};
