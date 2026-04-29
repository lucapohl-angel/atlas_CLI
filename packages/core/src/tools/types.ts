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

export interface Tool<I = unknown> {
  readonly name: string;
  readonly description: string;
  readonly approval: ApprovalMode;
  /**
   * Zod schema for the tool input. We accept any ZodType and project the
   * parsed (output) shape into `I` so tools can use `.default()` etc.
   * without fighting input-vs-output variance.
   */
  readonly schema: z.ZodType<I, z.ZodTypeDef, unknown>;
  execute(input: I, ctx: ToolContext): Promise<Result<ToolOk, AtlasError>>;
}
