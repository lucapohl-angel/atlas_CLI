/**
 * Hook registry + runner.
 *
 * `runHooks` returns the aggregated decision:
 *   - `allow` if every hook allowed (or none registered).
 *   - `block` on the first blocking hook (short-circuits).
 *   - `modify` carrying the latest mutated payload if any hook modified.
 */
import { childLogger } from '../logger.js';
import type { HookCtx, HookEvent, HookResult, HookSpec } from './types.js';

const log = childLogger('hooks');

export class HookRegistry {
  private readonly hooks: HookSpec[] = [];

  register<E extends HookEvent>(spec: HookSpec<E>): void {
    this.hooks.push(spec as HookSpec);
  }

  list(event?: HookEvent): readonly HookSpec[] {
    if (!event) return [...this.hooks];
    return this.hooks.filter((h) => h.event === event);
  }
}

const matches = (spec: HookSpec, ctx: HookCtx): boolean => {
  if (!spec.matcher) return true;
  const target =
    ctx.event === 'beforeTool' || ctx.event === 'afterTool'
      ? (ctx as { tool: string }).tool
      : '';
  if (typeof spec.matcher === 'string') return spec.matcher === target;
  return spec.matcher.test(target);
};

export const runHooks = async <E extends HookEvent>(
  registry: HookRegistry,
  event: E,
  ctx: HookCtx<E>
): Promise<HookResult> => {
  let lastModify: HookResult | null = null;
  for (const spec of registry.list(event)) {
    if (!matches(spec, ctx as HookCtx)) continue;
    let result: HookResult;
    try {
      result = await (spec.handler as (c: HookCtx<E>) => Promise<HookResult>)(ctx);
    } catch (e) {
      log.error({ err: e, event }, 'hook handler threw');
      return {
        action: 'block',
        reason: `hook ${event} threw: ${e instanceof Error ? e.message : String(e)}`
      };
    }
    if (result.action === 'block') return result;
    if (result.action === 'modify') lastModify = result;
  }
  return lastModify ?? { action: 'allow' };
};
