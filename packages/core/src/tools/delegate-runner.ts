/**
 * Default factory for `DelegateRunFn` — wires the host's provider,
 * agent registry, and base tool registry into a child agent loop.
 *
 * The host (TUI / REPL / scripted runner) calls this once per session
 * and stuffs the returned function into `ToolContext.delegateRun`. The
 * `delegate` tool then orchestrates fan-out and concurrency on top.
 *
 * Children are constrained vs. the parent in three ways:
 *   1. The `delegate`, `clarify`, and any caller-listed `blockedTools`
 *      are stripped from the child registry — children can't recurse
 *      indefinitely, can't ask the user questions, and can't escape
 *      the parent's safety rails.
 *   2. Approval policy is **deny-by-default** for `ask`-mode tools.
 *      Children run unattended; if they hit `terminal` etc. the call
 *      is refused with a clear message instead of hanging.
 *   3. `delegateDepth` is incremented before invocation. The tool
 *      checks this against `maxDepth` and refuses past the cap.
 */
import { childLogger } from '../logger.js';
import type { Agent } from '../agents/types.js';
import { buildSystemPrompt } from '../agents/loader.js';
import { runAgentLoop } from '../loop/agent-loop.js';
import type { Provider } from '../providers/types.js';
import type { Skill } from '../skills/types.js';
import type { HookRegistry } from '../hooks/index.js';
import { ToolRegistry } from './registry.js';
import type {
  ApprovalDecision,
  DelegateChildRequest,
  DelegateChildResult,
  DelegateRunFn,
  Tool,
  ToolContext
} from './types.js';

const log = childLogger('delegate');

const STRIPPED_FROM_CHILDREN: ReadonlySet<string> = new Set(['delegate', 'clarify']);

export interface CreateDelegateRunnerOptions {
  readonly provider: Provider;
  readonly model: string;
  readonly fallbackModels?: readonly string[];
  /** All known agents — looked up by name when the caller passes `agent`. */
  readonly agents: ReadonlyMap<string, Agent>;
  /** Default agent for children when the request omits `agent`. */
  readonly defaultAgent: Agent;
  /** Skills available to children (usually the parent's set). */
  readonly skills: readonly Skill[];
  /**
   * Source registry. We clone it per-child so we can strip blocked
   * tools without mutating the parent's view.
   */
  readonly baseTools: ToolRegistry;
  /** Tool names that may not run inside a child loop. */
  readonly blockedTools?: readonly string[];
  readonly hooks?: HookRegistry;
  readonly maxRounds?: number;
  /** cwd / approval-baseline for the child. */
  readonly baseToolContext: Pick<ToolContext, 'cwd'>;
  /** Current depth of *this* runner. The child sees `currentDepth + 1`. */
  readonly currentDepth?: number;
  readonly maxDepth?: number;
  readonly logger?: (line: string) => void;
}

const denyAskApproval = {
  decide(_tool: string, _input: unknown): ApprovalDecision {
    return {
      action: 'deny',
      reason:
        'subagents run unattended; ask-approval tools (terminal write/exec, etc.) are blocked. Surface the request to the parent agent instead.'
    };
  }
};

const buildChildRegistry = (
  base: ToolRegistry,
  extraBlocked: readonly string[]
): ToolRegistry => {
  const blocked = new Set<string>([...STRIPPED_FROM_CHILDREN, ...extraBlocked]);
  const r = new ToolRegistry();
  for (const t of base.list()) {
    if (blocked.has(t.name)) continue;
    r.register(t as Tool<unknown>);
  }
  return r;
};

const truncate = (s: string, max = 4000): string =>
  s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;

export const createDelegateRunner = (
  opts: CreateDelegateRunnerOptions
): DelegateRunFn => {
  return async (req: DelegateChildRequest): Promise<DelegateChildResult> => {
    const agent = req.agent ? opts.agents.get(req.agent) ?? opts.defaultAgent : opts.defaultAgent;
    const childTools = buildChildRegistry(opts.baseTools, opts.blockedTools ?? []);
    const system = buildSystemPrompt(agent, opts.skills);
    const userBody = req.context ? `Context:\n${req.context}\n\n---\n\nGoal:\n${req.goal}` : req.goal;

    const childCtx: ToolContext = {
      cwd: opts.baseToolContext.cwd,
      approve: denyAskApproval,
      ...(req.signal ? { signal: req.signal } : {}),
      callingAgent: { name: agent.name },
      delegateDepth: (opts.currentDepth ?? 0) + 1
      // No delegateRun / clarifyAsk — children can't fan out further
      // (delegate is also stripped from their registry as a belt-and-braces).
    };

    let assistantText = '';
    let rounds = 0;
    let errorMsg: string | undefined;

    try {
      const events = runAgentLoop({
        provider: opts.provider,
        model: opts.model,
        ...(opts.fallbackModels ? { fallbackModels: opts.fallbackModels } : {}),
        tools: childTools,
        toolContext: childCtx,
        initialMessages: [
          { role: 'system', content: system },
          { role: 'user', content: userBody }
        ],
        ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
        ...(opts.hooks ? { hooks: opts.hooks } : {}),
        ...(req.signal ? { signal: req.signal } : {})
      });

      for await (const ev of events) {
        if (ev.type === 'delta') assistantText += ev.text;
        else if (ev.type === 'done') rounds = ev.rounds;
        else if (ev.type === 'error') errorMsg = ev.error.message;
        else if (ev.type === 'turn_end') {
          // Capture last assistant message as authoritative summary.
          const c = ev.assistantMessage.content;
          if (typeof c === 'string') assistantText = c;
        }
      }
    } catch (e) {
      errorMsg = (e as Error).message;
    }

    if (errorMsg) {
      return {
        ok: false,
        summary: `(child failed) ${errorMsg}`,
        error: errorMsg,
        rounds,
        agent: agent.name
      };
    }
    log.debug({ agent: agent.name, rounds, chars: assistantText.length }, 'child completed');
    return {
      ok: true,
      summary: truncate(assistantText.trim() || '(no output)'),
      rounds,
      agent: agent.name
    };
  };
};
