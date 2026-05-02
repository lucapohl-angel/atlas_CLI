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

export const ArtifactKeySchema = z.enum([
  'brief',
  'prd',
  'architecture',
  'ux-spec',
  'design-system',
  'epics'
]);
export type ArtifactKey = z.infer<typeof ArtifactKeySchema>;

export const ArtifactStatusSchema = z.enum(['missing', 'draft', 'ready', 'done']);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const WorkflowStoryStatusSchema = z.enum([
  'draft',
  'ready-for-dev',
  'in-progress',
  'review',
  'done',
  'blocked'
]);
export type WorkflowStoryStatus = z.infer<typeof WorkflowStoryStatusSchema>;

export const ChainRequiresSchema = z.object({
  hasPRD: z.boolean().optional(),
  hasArchitecture: z.boolean().optional(),
  hasStories: z.boolean().optional(),
  minStories: z.number().int().nonnegative().optional(),
  storyStatus: WorkflowStoryStatusSchema.optional(),
  artifact: ArtifactKeySchema.optional(),
  status: ArtifactStatusSchema.optional()
});
export type ChainRequires = z.infer<typeof ChainRequiresSchema>;

const ActivationSchemaRaw = z.object({
  prepend: z.array(z.string()).optional(),
  append: z.array(z.string()).optional(),
  persistentFacts: z.array(z.string()).optional(),
  persistent_facts: z.array(z.string()).optional(),
  onComplete: z.string().optional(),
  on_complete: z.string().optional()
});

export const WorkflowActivationSchema = ActivationSchemaRaw.transform((v) => ({
  prepend: v.prepend ?? [],
  append: v.append ?? [],
  persistentFacts: v.persistentFacts ?? v.persistent_facts ?? [],
  onComplete: v.onComplete ?? v.on_complete
}));
export type WorkflowActivation = z.infer<typeof WorkflowActivationSchema>;

export const ChainStepSchema = z.object({
  fromAgent: Identifier,
  /** Optional command filter. When omitted, matches any command from `fromAgent`. */
  command: z.string().optional(),
  toAgent: Identifier,
  /** Suggested command for the next agent. */
  nextCommand: z.string().optional(),
  /** Human-readable rationale; surfaced by `*next`/`atlas status`. */
  reason: z.string().optional(),
  /** Optional gate: step is eligible only when requirements are met. */
  requires: ChainRequiresSchema.optional(),
  /** Optional halt messages when this step should not proceed. */
  halt: z.array(z.string()).optional()
});
export type ChainStep = z.infer<typeof ChainStepSchema>;

export const ChainsFileSchema = z.object({
  version: z.number().int().default(1),
  activation: WorkflowActivationSchema.optional(),
  chains: z.array(ChainStepSchema).default([])
});
export type ChainsFile = z.infer<typeof ChainsFileSchema>;
