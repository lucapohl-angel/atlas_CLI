/**
 * Tool contract — the typed interface every tool implements.
 *
 * Each tool declares:
 *   - a stable string name
 *   - a Zod schema that validates inputs at the agent/model boundary
 *   - an `approval` mode defining when user consent is required
 *   - an async `execute` that always returns a Result (never throws for
 *     recoverable failures) and always honors `signal`
 */
import type { z } from 'zod';
import type { AtlasError } from '../errors.js';
import type { Result } from '../result.js';

export type ApprovalMode = 'auto' | 'ask' | 'never';

export interface ToolContext {
  /** Cancellation. Tools must check periodically and abort cleanly. */
  readonly signal?: AbortSignal;
  /** Working directory the tool should resolve relative paths against. */
  readonly cwd: string;
  /**
   * Approval policy decides whether `ask`-mode tools actually prompt or
   * are auto-approved (e.g. `--yes` flag, hook-driven decisions).
   */
  readonly approve: ApprovalPolicy;
  /**
   * Optional identity of the agent currently driving the loop. Tools that
   * enforce per-agent boundaries (e.g. `story_update`) consult this to
   * decide whether a write is authorized. Omit for direct user tool
   * invocations or contexts without a specific agent.
   */
  readonly callingAgent?: {
    readonly name: string;
    readonly authorizedSections?: readonly string[];
    readonly forbiddenSections?: readonly string[];
  };
}

export type ApprovalDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'deny'; readonly reason: string };

export interface ApprovalPolicy {
  decide(tool: string, input: unknown): Promise<ApprovalDecision> | ApprovalDecision;
}

export type ToolOk = {
  readonly type: 'ok';
  /** Short string suitable for inclusion in the model's context. */
  readonly summary: string;
  /** Optional structured payload for hosts/UIs (not for the model). */
  readonly data?: unknown;
};

export type ToolFail = { readonly type: 'error'; readonly error: AtlasError };

export type ToolResult = ToolOk | ToolFail;

/**
 * One concrete usage example. Surfaces a JSON-encoded input, a one-line
 * outcome, and an optional `note` so the model can pattern-match the
 * tool's actual contract instead of guessing from the schema alone.
 */
export interface ToolExample {
  /** What the input would look like, encoded as a JSON string. */
  readonly input: string;
  /** One-line description of what happens / what comes back. */
  readonly result: string;
  /** Optional caveat, edge case, or "do this instead" pointer. */
  readonly note?: string;
}

export interface Tool<I = unknown> {
  readonly name: string;
  /**
   * One-line summary. Kept short so it works in dense lists. The richer,
   * model-facing description is composed via `composeToolDescription`
   * from this field plus the optional fields below.
   */
  readonly description: string;
  readonly approval: ApprovalMode;
  /**
   * Zod schema for the tool input. We accept any ZodType and project the
   * parsed (output) shape into `I` so tools can use `.default()` etc.
   * without fighting input-vs-output variance.
   */
  readonly schema: z.ZodType<I, z.ZodTypeDef, unknown>;
  /**
   * When the model SHOULD reach for this tool. Free-form prose. Surfaces
   * verbatim in the composed description so the agent has guidance, not
   * just a schema. Recommended length: 1–3 sentences.
   */
  readonly whenToUse?: string;
  /**
   * Operations the tool will refuse / require approval for, listed as
   * human-readable phrases ("force-push", "rm -rf", "DROP TABLE"). Used
   * by the description composer so the model knows the boundaries; not
   * (yet) machine-enforced beyond the existing approval policy.
   */
  readonly blockedOps?: readonly string[];
  /**
   * What the tool's `summary` field looks like on success — the shape
   * the model should expect to parse / re-quote. Keeps the contract
   * explicit instead of letting the model infer it from a sample.
   */
  readonly outputContract?: string;
  /** A handful of canonical examples. Ordered by importance. */
  readonly examples?: readonly ToolExample[];
  execute(input: I, ctx: ToolContext): Promise<Result<ToolOk, AtlasError>>;
}

/**
 * Compose the rich, model-facing description from the tool's fields.
 * Used by the provider tool-spec serializer so every provider sees the
 * same enriched contract — never the bare one-liner.
 *
 * Format (sections omitted when fields are empty):
 *
 *   <description>
 *
 *   When to use: <whenToUse>
 *
 *   Output contract: <outputContract>
 *
 *   Blocked operations: <blockedOps joined>
 *
 *   Examples:
 *     - input: <example.input>
 *       result: <example.result>
 *       note: <example.note>
 */
export const composeToolDescription = (tool: Tool<unknown>): string => {
  const parts: string[] = [tool.description.trim()];
  if (tool.whenToUse && tool.whenToUse.trim().length > 0) {
    parts.push(`When to use: ${tool.whenToUse.trim()}`);
  }
  if (tool.outputContract && tool.outputContract.trim().length > 0) {
    parts.push(`Output contract: ${tool.outputContract.trim()}`);
  }
  if (tool.blockedOps && tool.blockedOps.length > 0) {
    parts.push(
      `Blocked operations (require approval / refused): ${tool.blockedOps.join('; ')}`
    );
  }
  if (tool.examples && tool.examples.length > 0) {
    const lines = tool.examples.map((e) => {
      const head = `  - input: ${e.input}\n    result: ${e.result}`;
      return e.note ? `${head}\n    note: ${e.note}` : head;
    });
    parts.push(`Examples:\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
};
