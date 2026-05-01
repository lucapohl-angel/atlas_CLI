/**
 * Agent = a persona with role, system prompt, model, and handoff
 * triggers. Stored on disk as `~/.atlas/agents/<name>/AGENT.md` with
 * YAML frontmatter:
 *
 *   ---
 *   name: athena
 *   role: PM
 *   description: Strategic wisdom, deliberate planning.
 *   model: anthropic/claude-sonnet-4
 *   handoffs:
 *     - to: prometheus
 *       when: hasPRD
 *   ---
 *   You are Athena... <system prompt body>
 */
import { z } from 'zod';

export const HandoffSchema = z.object({
  to: z.string().min(1),
  /** Free-form trigger description; the orchestrator interprets it. */
  when: z.string().min(1)
});

export const AgentCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1)
});

/**
 * Concrete usage example surfaced inside the system prompt. Lets the
 * model see what "good output" looks like for this specific persona —
 * input fragment + the response or artefact it produced. Keeps the
 * persona grounded in real shapes, not adjectives.
 */
export const AgentExampleSchema = z.object({
  /** What the user (or upstream agent) said. Quote-form is fine. */
  input: z.string().min(1),
  /** What this agent should produce. May be a snippet or a sketch. */
  output: z.string().min(1),
  /** Optional rationale or "what makes this good". */
  note: z.string().optional()
});

export const AgentFrontmatterSchema = z.object({
  name: z.string().min(1),
  /** Crisp SDD role label: PM, Architect, SM, Dev, QA, etc. */
  role: z.string().min(1),
  description: z.string().min(1),
  /**
   * Optional human-friendly alias (e.g. a Greek-god codename). Purely
   * cosmetic — never appears as the leading frame of the system prompt.
   */
  personaAlias: z.string().optional(),
  model: z.string().optional(),
  /**
   * Default permission posture for this agent.
   *   - `plan`      : read-only / advisory; no writes/terminal without approval.
   *   - `build`     : full tool access subject to per-tool approval policy.
   *   - `autopilot` : full tool access with NO approval prompts. The user
   *                   must opt in once per session (TUI confirmation popup).
   */
  mode: z.enum(['plan', 'build', 'autopilot']).default('build'),
  /** Optional default reasoning effort (off / low / medium / high). */
  thinkingEffort: z.enum(['off', 'low', 'medium', 'high']).default('off'),
  /** Skills this agent should always have indexed (on top of triggers). */
  skills: z.array(z.string()).default([]),
  handoffs: z.array(HandoffSchema).default([]),
  /**
   * `*command` palette the agent advertises. Users invoke with
   * `*command-name` in chat. Re-rendered into the system prompt so the
   * model knows what it can be asked to do.
   */
  commands: z.array(AgentCommandSchema).default([]),
  /**
   * Whether this agent is part of the framework (the SDD pipeline +
   * orchestrator that ship with Atlas) or was added by the user.
   *
   * The TUI hides framework agents from the manual switcher because
   * they are routed to by the orchestrator — the user shouldn't have to
   * remember which one to pick. User agents always appear.
   */
  kind: z.enum(['framework', 'user']).default('user'),

  // ───────────────────── Persona DNA (additive, optional) ─────────────────────
  // The following fields enrich the agent's prompt without breaking any
  // existing AGENT.md file. All defaults are empty / undefined, so a
  // minimal AGENT.md continues to load and render the same as before.

  /**
   * Voice / writing style cues. Short bullet list. Surfaces in the prompt
   * as a "Voice DNA" section so the model produces output that *sounds*
   * like this persona — not just talks about being it. Examples:
   *   - "Crisp, present-tense, no hedging"
   *   - "Quote the user's exact words back when refining intent"
   */
  voiceDna: z.array(z.string().min(1)).optional(),
  /**
   * Activation ritual — what this agent does on its very first turn,
   * before responding to anything else. Things like "list your *commands"
   * or "run *status to detect project state". Single short paragraph.
   */
  activation: z.string().optional(),
  /**
   * Capability boundaries — explicit "I do NOT do this" statements that
   * keep the agent in its lane. Examples:
   *   - "Never push to a branch — that is Iris's job"
   *   - "Never write code — produce specs only"
   * Surfaces as a "Boundaries" section in the prompt.
   */
  capabilityBoundaries: z.array(z.string().min(1)).optional(),
  /**
   * Data references — file paths under `~/.atlas/data/` (or relative
   * project paths) the agent should consult on demand. Surfaced as a
   * one-line index so the model knows what library it has.
   */
  dataRefs: z.array(z.string().min(1)).optional(),
  /**
   * In-prompt examples of this agent's good output. Kept short — 2-4
   * examples max. Surfaces as a "Reference outputs" section.
   */
  examples: z.array(AgentExampleSchema).optional(),
  /**
   * Templates the agent should reach for. Refers to template ids
   * registered with the templates engine (Phase 3) or to relative
   * paths under `~/.atlas/templates/`. Surfaced as a one-line index.
   */
  templates: z.array(z.string().min(1)).optional(),
  /**
   * Checklists the agent must run as part of its definition-of-done.
   * Refers to checklist ids registered with the checklists engine
   * (Phase 4) or to relative paths under `~/.atlas/checklists/`.
   */
  checklists: z.array(z.string().min(1)).optional(),
  /**
   * Sections of a story file (or other shared artefact) this agent is
   * authorized to write to. Enforced at the `story_update` tool boundary
   * (Phase 5). Empty / undefined means "no story write authority".
   */
  authorizedSections: z.array(z.string().min(1)).optional(),
  /**
   * Sections that are explicitly off-limits — overrides authorized when
   * a section name appears in both. Used by guard agents (e.g. PO never
   * edits "Implementation Notes").
   */
  forbiddenSections: z.array(z.string().min(1)).optional()
});

export type Handoff = z.infer<typeof HandoffSchema>;
export type AgentCommand = z.infer<typeof AgentCommandSchema>;
export type AgentExample = z.infer<typeof AgentExampleSchema>;
export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

export interface Agent extends AgentFrontmatter {
  readonly path: string;
  /** The system prompt body (markdown after frontmatter). */
  readonly systemPrompt: string;
}

/**
 * Names of every built-in "framework" agent — the SDD pipeline crew that
 * the orchestrator routes between. Used by the TUI to hide them from the
 * user-facing picker (they get reached via handoffs, not manual switching).
 *
 * Listed here so the rule applies even to users who installed agents from
 * an older `atlas init` that did not set `kind: framework` in frontmatter.
 */
export const FRAMEWORK_AGENT_NAMES: ReadonlySet<string> = new Set([
  'atlas',
  'athena',
  'prometheus',
  'aphrodite',
  'hermes',
  'hestia',
  'hercules',
  'nemesis',
  'demeter',
  'iris',
  'apollo'
]);

/**
 * True when an agent should be treated as a framework specialist
 * (orchestrator-routed, hidden from the manual switcher). Considers both
 * the explicit `kind` field and the legacy hard-coded name list so that
 * users with stale on-disk installs still get the right behavior.
 */
export const isFrameworkAgent = (a: Pick<Agent, 'name' | 'kind'>): boolean =>
  a.kind === 'framework' || FRAMEWORK_AGENT_NAMES.has(a.name);
