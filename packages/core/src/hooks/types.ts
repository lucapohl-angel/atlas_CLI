/**
 * Hook system — typed lifecycle events with real blocking semantics.
 *
 * Hooks register against an event name plus an optional matcher. When
 * the engine fires `runHooks(event, ctx)` they run in registration
 * order; the first `block` short-circuits and is returned. `modify`
 * results overwrite the payload for subsequent hooks.
 */
import type { ToolOk } from '../tools/types.js';

export type HookEvent =
  | 'sessionStart'
  | 'sessionEnd'
  | 'beforeMessage'
  | 'afterMessage'
  | 'beforeTool'
  | 'afterTool';

export interface HookCtxBase {
  readonly event: HookEvent;
  readonly signal?: AbortSignal;
}

export interface SessionCtx extends HookCtxBase {
  readonly event: 'sessionStart' | 'sessionEnd';
  readonly sessionId: string;
}

export interface MessageCtx extends HookCtxBase {
  readonly event: 'beforeMessage' | 'afterMessage';
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface BeforeToolCtx extends HookCtxBase {
  readonly event: 'beforeTool';
  readonly tool: string;
  readonly input: unknown;
  /**
   * Content of the most recent user-role message in the conversation,
   * if any. Populated by the agent loop so hooks can react to vague /
   * contradictory user input without re-reading the message history.
   */
  readonly lastUserMessage?: string;
}

export interface AfterToolCtx extends HookCtxBase {
  readonly event: 'afterTool';
  readonly tool: string;
  readonly input: unknown;
  readonly result: ToolOk | { readonly type: 'error'; readonly message: string };
}

export type HookCtx<E extends HookEvent = HookEvent> = E extends
  | 'sessionStart'
  | 'sessionEnd'
  ? SessionCtx
  : E extends 'beforeMessage' | 'afterMessage'
    ? MessageCtx
    : E extends 'beforeTool'
      ? BeforeToolCtx
      : E extends 'afterTool'
        ? AfterToolCtx
        : HookCtxBase;

export type HookResult =
  | { readonly action: 'allow' }
  | { readonly action: 'block'; readonly reason: string }
  | { readonly action: 'modify'; readonly payload: unknown };

export interface HookHandler<E extends HookEvent = HookEvent> {
  (ctx: HookCtx<E>): Promise<HookResult> | HookResult;
}

export interface HookSpec<E extends HookEvent = HookEvent> {
  readonly event: E;
  /**
   * Optional predicate. For `beforeTool` / `afterTool` this is matched
   * against `ctx.tool`. For other events it always runs.
   */
  readonly matcher?: string | RegExp;
  readonly handler: HookHandler<E>;
}
