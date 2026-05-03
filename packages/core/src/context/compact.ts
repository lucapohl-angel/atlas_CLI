/**
 * Runtime auto-compaction.
 *
 * `planCompaction` (in `./window.ts`) decides *when* and *what* to
 * compact. This module wires that plan up to a real provider so the
 * orchestrator can actually shrink a long conversation in place by
 * asking a model to summarize the older turns.
 *
 * Defaults:
 *  - Uses the **active** model unless the caller passes a different
 *    `summarizerModel` (lets users opt for a cheap summarizer via
 *    `compaction.model` in their config).
 *  - Triggers when the running token count crosses `threshold` * the
 *    model's context window (default 0.8).
 *
 * Honors the caller's `AbortSignal` so a long summarization can be
 * cancelled along with the rest of the turn.
 */
import { err, ok, type Result } from '../result.js';
import type { AtlasError } from '../errors.js';
import type { Message, Provider } from '../providers/types.js';
import {
  applyCompaction,
  buildCompactPrompt,
  countMessageTokens,
  planCompaction,
  pruneStaleToolResults,
  type ModelLimits,
  type TokenCounter
} from './window.js';

export interface CompactOptions {
  readonly provider: Provider;
  /** Model id used to perform the summarization. */
  readonly summarizerModel: string;
  readonly limits: ModelLimits;
  readonly counter?: TokenCounter;
  readonly signal?: AbortSignal;
}

export interface CompactOutcome {
  readonly messages: readonly Message[];
  /** True when compaction actually ran (false = under threshold or no-op). */
  readonly compacted: boolean;
  /** Number of older turns rolled into the summary (0 when not compacted). */
  readonly summarized: number;
}

/**
 * Compact `messages` if the running token count is above threshold.
 * Returns the (possibly unchanged) message list. Errors from the
 * summarizer call propagate as `Result.err` — callers may choose to
 * fall through with the original messages.
 */
export const compactIfNeeded = async (
  messages: readonly Message[],
  opts: CompactOptions
): Promise<Result<CompactOutcome, AtlasError>> => {
  // Cheap pre-pass: elide stale tool-result bodies. If that alone gets
  // us comfortably under threshold we can skip the LLM call entirely.
  const pruned = pruneStaleToolResults(messages, opts.limits.recentTurns ?? 8);
  const threshold =
    (opts.limits.compactThreshold ?? 0.8) * opts.limits.contextTokens;
  if (
    pruned.bytesElided > 0 &&
    countMessageTokens(pruned.messages, opts.counter) < threshold
  ) {
    return ok({ messages: pruned.messages, compacted: false, summarized: 0 });
  }

  const plan = planCompaction(pruned.messages, opts.limits, opts.counter);
  if (plan.action === 'keep') {
    return ok({ messages: pruned.messages, compacted: pruned.bytesElided > 0, summarized: 0 });
  }

  const prompt = buildCompactPrompt(plan.olderToSummarize);
  const stream = opts.provider.stream({
    model: opts.summarizerModel,
    messages: [
      {
        role: 'system',
        content:
          'You are a precise conversation summarizer. Output only the summary text.'
      },
      { role: 'user', content: prompt }
    ],
    ...(opts.signal ? { signal: opts.signal } : {})
  });

  let summary = '';
  for await (const ev of stream) {
    if (ev.type === 'delta') summary += ev.text;
    else if (ev.type === 'error') return err(ev.error);
    // `done` is fine — we drop usage; `thinking` / tool events are ignored.
  }

  if (summary.trim().length === 0) {
    return ok({ messages, compacted: false, summarized: 0 });
  }

  return ok({
    messages: applyCompaction(plan.recentToKeep, summary),
    compacted: true,
    summarized: plan.olderToSummarize.length
  });
};
