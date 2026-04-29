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
import type { Message } from '../providers/types.js';

export interface ModelLimits {
  /** Hard context limit reported by the model (in tokens). */
  readonly contextTokens: number;
  /** Compact threshold (default 0.8). */
  readonly compactThreshold?: number;
}

export type TokenCounter = (text: string) => number;

export const approximateTokenCount: TokenCounter = (text: string): number =>
  Math.ceil(text.length / 4);

export const countMessageTokens = (
  messages: readonly Message[],
  counter: TokenCounter = approximateTokenCount
): number => {
  let total = 0;
  for (const m of messages) total += counter(m.content) + 4; // role overhead
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

  // Keep the system prompt (if any) + the last 4 messages verbatim.
  const systemPrefix = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const recent = nonSystem.slice(-4);
  const older = nonSystem.slice(0, -4);
  if (older.length === 0) return { action: 'keep' };

  return {
    action: 'compact',
    olderToSummarize: older,
    recentToKeep: [...systemPrefix, ...recent]
  };
};

/** Build the prompt the host sends to a cheap model to produce the summary. */
export const buildCompactPrompt = (older: readonly Message[]): string => {
  const transcript = older
    .map((m) => `[${m.role}]: ${m.content}`)
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
