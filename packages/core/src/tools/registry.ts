/**
 * Tool registry + invoke pipeline.
 *
 * `invokeTool` performs:
 *   1. Schema validation (Zod) — `TOOL_INPUT_INVALID` on failure.
 *   2. Approval check based on the tool's `approval` mode + policy.
 *   3. Execution under the supplied AbortSignal.
 *
 * Hooks plug in around step 2 (Phase 4) without changing this contract.
 */
import { atlasError, type AtlasError } from '../errors.js';
import { err, type Result } from '../result.js';
import type { Tool, ToolContext, ToolOk } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown>>();

  register<I>(tool: Tool<I>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as Tool<unknown>);
  }

  get(name: string): Tool<unknown> | undefined {
    return this.tools.get(name);
  }

  list(): readonly Tool<unknown>[] {
    return [...this.tools.values()];
  }
}

export const invokeTool = async (
  registry: ToolRegistry,
  name: string,
  rawInput: unknown,
  ctx: ToolContext
): Promise<Result<ToolOk, AtlasError>> => {
  const tool = registry.get(name);
  if (!tool) {
    return err(atlasError('TOOL_NOT_FOUND', `no such tool: ${name}`, { context: { name } }));
  }

  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    return err(
      atlasError('TOOL_INPUT_INVALID', `invalid input for ${name}`, {
        context: { name, issues: parsed.error.issues }
      })
    );
  }

  if (tool.approval !== 'auto') {
    if (tool.approval === 'never') {
      return err(
        atlasError('TOOL_DENIED_BY_USER', `tool ${name} is disabled (approval: never)`)
      );
    }
    const decision = await ctx.approve.decide(name, parsed.data);
    if (decision.action === 'deny') {
      return err(
        atlasError('TOOL_DENIED_BY_USER', `tool ${name} denied: ${decision.reason}`, {
          context: { name }
        })
      );
    }
  }

  if (ctx.signal?.aborted) {
    return err(atlasError('TOOL_CANCELLED', `tool ${name} cancelled before execution`));
  }

  return tool.execute(parsed.data, ctx);
};

/** Auto-approve everything. Useful in tests and `--yes` mode. */
export const allowAllPolicy = {
  decide: (): { action: 'allow' } => ({ action: 'allow' })
};

/** Deny everything that isn't `auto`. Most paranoid mode. */
export const denyAllPolicy = {
  decide: (tool: string): { action: 'deny'; reason: string } => ({
    action: 'deny',
    reason: `${tool} requires approval and policy is deny-all`
  })
};
