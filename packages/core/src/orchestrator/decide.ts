/**
 * Orchestrator decision: project state → recommended agent name.
 *
 * The mapping is deliberately simple and explicit. Higher-fidelity
 * decision-making is a hook responsibility.
 */
import type { ProjectState } from './state.js';

export interface AgentRecommendation {
  readonly agent: string;
  readonly reason: string;
}

export const recommendAgent = (state: ProjectState): AgentRecommendation => {
  if (!state.hasPRD) {
    return { agent: 'athena', reason: 'no docs/prd.md — start with PM' };
  }
  if (!state.hasArchitecture) {
    return { agent: 'prometheus', reason: 'PRD exists, missing docs/architecture.md' };
  }
  // Once architecture is locked the project is real enough that the
  // context pack pays for itself: every subsequent story execution
  // reads it, and the auto-tracker hook needs the file to exist.
  if (!state.hasContextPack) {
    return {
      agent: 'athena',
      reason: 'PRD + architecture exist, missing context/project-overview.md — scaffold the context pack'
    };
  }
  if (!state.hasStories) {
    return { agent: 'hestia', reason: 'architecture done, need story breakdown' };
  }
  return { agent: 'hercules', reason: `${state.storyCount} stories ready to execute` };
};
