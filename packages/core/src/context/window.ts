/**
 * Token-budget tracker + context compaction.
 *
 * Atlas does NOT bundle a tokenizer (different per-model, large download).
 * Instead it uses a calibrated character-count approximation:
 *   ~4 chars per token for English/code text.
 * Hosts that need accuracy can pass a `countTokens` function override.
 *
 * When `usedRatio()` exceeds 0.8, the orchestrator should compact older
 * turns by summarizing them with a cheap model (`buildCompactPrompt`).
 */
import { contentToString, type Message } from '../providers/types.js';

export interface ModelLimits {
  /** Hard context limit reported by the model (in tokens). */
  readonly contextTokens: number;
  /** Compact threshold (default 0.8). */
  readonly compactThreshold?: number;
  /** Number of most-recent non-system turns kept verbatim. Default 8. */
  readonly recentTurns?: number;
}

export type TokenCounter = (text: string) => number;

export const approximateTokenCount: TokenCounter = (text: string): number =>
  Math.ceil(text.length / 4);

const VISION_TOKEN_ESTIMATE = 256;

export const countMessageTokens = (
  messages: readonly Message[],
  counter: TokenCounter = approximateTokenCount
): number => {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      total += counter(m.content) + 4; // role overhead
    } else {
      for (const b of m.content) {
        if (b.type === 'text') total += counter(b.text);
        else total += VISION_TOKEN_ESTIMATE;
      }
      total += 4; // role overhead
    }
  }
  return total;
};

export interface CompactionResult {
  readonly messages: readonly Message[];
  /** Number of turns that were rolled into the summary. */
  readonly compacted: number;
}

/**
 * Decide whether compaction is needed; if so, return the slice of older
 * messages to summarize and the messages to keep verbatim. The host then
 * runs the summarization (typically with a cheap model) and replaces
 * the compacted slice with a single system message.
 */
export const planCompaction = (
  messages: readonly Message[],
  limits: ModelLimits,
  counter: TokenCounter = approximateTokenCount
): { readonly action: 'keep' } | {
  readonly action: 'compact';
  readonly olderToSummarize: readonly Message[];
  readonly recentToKeep: readonly Message[];
} => {
  const used = countMessageTokens(messages, counter);
  const threshold = (limits.compactThreshold ?? 0.8) * limits.contextTokens;
  if (used < threshold || messages.length < 6) return { action: 'keep' };

  // Keep the system prompt (if any) + the last `recentTurns` messages.
  const systemPrefix = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const keep = Math.max(2, limits.recentTurns ?? 8);
  const recent = nonSystem.slice(-keep);
  const older = nonSystem.slice(0, -keep);
  if (older.length === 0) return { action: 'keep' };

  return {
    action: 'compact',
    olderToSummarize: older,
    recentToKeep: [...systemPrefix, ...recent]
  };
};

/**
 * Cheap pre-pass that elides the *content* of stale tool-result
 * messages (anything outside the last `keepRecent` non-system turns and
 * over `maxKeptBytes`). Preserves message count and roles so tool-call
 * pairing stays intact, but slashes token usage on long sessions where
 * the same file gets read many times.
 *
 * Returns the (possibly identical) messages plus the number of bytes
 * elided so callers can decide whether the savings are big enough to
 * skip a full LLM-based compaction.
 */
export const pruneStaleToolResults = (
  messages: readonly Message[],
  keepRecent = 8,
  maxKeptBytes = 1_500
): { readonly messages: readonly Message[]; readonly bytesElided: number } => {
  const nonSystemIdxs: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]!.role !== 'system') nonSystemIdxs.push(i);
  }
  const cutoff =
    nonSystemIdxs[Math.max(0, nonSystemIdxs.length - keepRecent)] ?? messages.length;

  let bytesElided = 0;
  const out: Message[] = messages.map((m, i) => {
    if (i >= cutoff) return m;
    if (m.role !== 'tool') return m;
    const text = typeof m.content === 'string' ? m.content : contentToString(m.content);
    if (text.length <= maxKeptBytes) return m;
    bytesElided += text.length;
    return {
      ...m,
      content: `${text.slice(0, 200)}\n…[stale tool result elided, ${text.length} chars]…`
    };
  });
  if (bytesElided === 0) return { messages, bytesElided: 0 };
  return { messages: out, bytesElided };
};

/** Build the prompt the host sends to a cheap model to produce the summary. */
export const buildCompactPrompt = (older: readonly Message[]): string => {
  const transcript = older
    .map((m) => `[${m.role}]: ${typeof m.content === 'string' ? m.content : contentToString(m.content)}`)
    .join('\n\n');
  return [
    'Summarize the following conversation history into a compact briefing',
    'that preserves: user goals, decisions made, file paths touched, and',
    'open questions. Aim for under 400 words. Output the summary only.',
    '',
    transcript
  ].join('\n');
};

/** Stitch the compacted summary back into the message list. */
export const applyCompaction = (
  recentToKeep: readonly Message[],
  summary: string
): readonly Message[] => {
  const summaryMsg: Message = {
    role: 'system',
    content: `Previous conversation summary:\n${summary.trim()}`
  };
  // Insert the summary after any existing system messages.
  const sys = recentToKeep.filter((m) => m.role === 'system');
  const rest = recentToKeep.filter((m) => m.role !== 'system');
  return [...sys, summaryMsg, ...rest];
};
