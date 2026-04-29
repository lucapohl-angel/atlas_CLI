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
  kind: z.enum(['framework', 'user']).default('user')
});

export type Handoff = z.infer<typeof HandoffSchema>;
export type AgentCommand = z.infer<typeof AgentCommandSchema>;
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
