/**
 * Workflow chains: declarative `(fromAgent, command) → nextAgent.command`
 * routing. Used by the orchestrator's `recommendNext` to chain personas
 * without hardcoding the graph in code.
 *
 * A chain is consulted *after* the handoff queue (which always wins) and
 * *before* the static state-based recommendation (the fallback). Users
 * customise routing by editing `~/.atlas/workflows/chains.yaml` (or the
 * project-local `<cwd>/.atlas/workflows/chains.yaml` if present).
 */
import { z } from 'zod';

export const Identifier = z.string().regex(/^[a-z][a-z0-9-]*$/, {
  message: 'identifier must be lowercase kebab-case'
});

export const ChainStepSchema = z.object({
  fromAgent: Identifier,
  /** Optional command filter. When omitted, matches any command from `fromAgent`. */
  command: z.string().optional(),
  toAgent: Identifier,
  /** Suggested command for the next agent. */
  nextCommand: z.string().optional(),
  /** Human-readable rationale; surfaced by `*next`/`atlas status`. */
  reason: z.string().optional()
});
export type ChainStep = z.infer<typeof ChainStepSchema>;

export const ChainsFileSchema = z.object({
  version: z.number().int().default(1),
  chains: z.array(ChainStepSchema).default([])
});
export type ChainsFile = z.infer<typeof ChainsFileSchema>;
