/**
 * Built-in tool: `delegate` — fan out one or more goals to child agents.
 *
 * Mirrors Hermes' `delegate_task`: single mode (`{goal, ...}`) drives one
 * child; batch mode (`{tasks: [...]}`) runs up to N tasks concurrently
 * (capped by `maxConcurrent`).
 *
 * The host wires a `delegateRun` into `ToolContext` via
 * `createDelegateRunner`. Without that wiring the tool returns a clear
 * "delegate is not initialized" error so behaviour is predictable in
 * tests/scripts that don't need fan-out.
 */
import { z } from 'zod';
import { atlasError } from '../errors.js';
import { err, ok } from '../result.js';
import type { DelegateChildResult, Tool } from './types.js';

const TaskSchema = z.object({
  goal: z.string().min(1).max(8000),
  context: z.string().max(20000).optional(),
  agent: z.string().min(1).max(80).optional()
});

const Input = z
  .object({
    goal: z.string().min(1).max(8000).optional(),
    context: z.string().max(20000).optional(),
    agent: z.string().min(1).max(80).optional(),
    tasks: z.array(TaskSchema).min(1).max(8).optional(),
    maxConcurrent: z.number().int().min(1).max(8).default(3)
  })
  .refine((v) => Boolean(v.goal) !== Boolean(v.tasks), {
    message: 'provide exactly one of `goal` (single mode) or `tasks` (batch mode)'
  });

const DEFAULT_MAX_DEPTH = 2;

/** Bounded `Promise.allSettled` with a configurable concurrency cap. */
const runWithConcurrency = async <T, R>(
  items: readonly T[],
  fn: (item: T, idx: number) => Promise<R>,
  limit: number
): Promise<readonly R[]> => {
  const out: R[] = new Array(items.length) as R[];
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      const itm = items[idx];
      if (itm === undefined) return;
      out[idx] = await fn(itm, idx);
    }
  });
  await Promise.all(workers);
  return out;
};

export const delegateTool: Tool<z.infer<typeof Input>> = {
  name: 'delegate',
  description:
    'Spawn child agent(s) to handle one or more goals concurrently. Single mode (`{goal}`) or batch (`{tasks: [...]}`).',
  approval: 'auto',
  schema: Input,
  whenToUse:
    'Use when (1) a goal has independent sub-goals that can run in parallel, (2) a sub-goal needs a different specialist agent, or (3) you want to isolate exploration from your main thread. Children cannot delegate further (depth cap, default 2). Children cannot ask the user — phrase goals self-contained. Prefer one well-scoped delegation over many tiny ones.',
  outputContract:
    'Returns a JSON object `{results: [{idx, ok, agent, summary, error?, rounds}]}` ordered by input index. `summary` is the child\'s last assistant message (truncated at ~4 KB). On total failure (no runner wired) returns `TOOL_EXECUTION_FAILED`.',
  blockedOps: [
    'recursive delegation past `delegation.maxDepth`',
    'children invoking ask-approval tools (terminal write/exec) — auto-denied',
    'children calling `clarify` or `delegate` — those tools are stripped from the child registry'
  ],
  examples: [
    {
      input: '{"goal":"summarize the README in 3 bullets","agent":"hermes"}',
      result: 'returns {results:[{idx:0, ok:true, summary:"- ..."}]}'
    },
    {
      input:
        '{"tasks":[{"goal":"audit deps","agent":"athena"},{"goal":"draft release notes","agent":"hermes"}],"maxConcurrent":2}',
      result: 'runs both children concurrently, returns ordered results array',
      note: 'Children execute in parallel; ordering of `results` matches input order regardless of completion order.'
    }
  ],
  async execute(input, ctx) {
    if (ctx.signal?.aborted) return err(atlasError('TOOL_CANCELLED', 'delegate cancelled'));

    const runner = ctx.delegateRun;
    if (!runner) {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          'delegate is not initialized in this session. The host must wire a delegate runner via createDelegateRunner before delegate can be used.'
        )
      );
    }

    const depth = ctx.delegateDepth ?? 0;
    if (depth >= DEFAULT_MAX_DEPTH) {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          `delegation depth limit reached (depth=${depth}, max=${DEFAULT_MAX_DEPTH}). Children cannot fan out further.`
        )
      );
    }

    const tasks: { goal: string; context?: string; agent?: string }[] =
      input.tasks ??
      (input.goal !== undefined
        ? [
            {
              goal: input.goal,
              ...(input.context !== undefined ? { context: input.context } : {}),
              ...(input.agent !== undefined ? { agent: input.agent } : {})
            }
          ]
        : []);

    const results = await runWithConcurrency(
      tasks,
      async (t): Promise<DelegateChildResult> => {
        try {
          return await runner({
            goal: t.goal,
            ...(t.context !== undefined ? { context: t.context } : {}),
            ...(t.agent !== undefined ? { agent: t.agent } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {})
          });
        } catch (e) {
          const msg = (e as Error).message;
          return { ok: false, summary: `(runner threw) ${msg}`, error: msg, rounds: 0 };
        }
      },
      input.maxConcurrent
    );

    const okCount = results.filter((r) => r.ok).length;
    const lines = results.map((r, i) => {
      const head = `[${i}] ${r.ok ? 'ok' : 'FAIL'} agent=${r.agent ?? 'default'} rounds=${r.rounds}`;
      return `${head}\n${r.summary}`;
    });

    return ok({
      type: 'ok',
      summary: `delegate: ${okCount}/${results.length} ok\n\n${lines.join('\n\n---\n\n')}`,
      data: { results: results.map((r, idx) => ({ idx, ...r })) }
    });
  }
};
