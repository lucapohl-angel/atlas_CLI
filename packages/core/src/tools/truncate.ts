/**
 * Shared truncation helper for tool outputs that get fed back to the
 * model.
 *
 * Strategy: head + tail, joined by an explicit "N chars elided" marker
 * so the model knows it was truncated and roughly by how much. Head
 * gets ~70% of the budget by default because most useful output (file
 * starts, error preambles, command echoes) lives at the top.
 *
 * Token math: at ~4 chars/token, the default 16K char budget bounds a
 * single tool result at ~4K tokens. That's ~50 cents of Claude Sonnet
 * input on a single hot turn — anything larger is almost always noise.
 */

export interface TruncateOptions {
  readonly maxChars?: number;
  readonly headRatio?: number;
  readonly marker?: (elided: number) => string;
}

const DEFAULT_MAX = 16_000;
const DEFAULT_HEAD_RATIO = 0.7;

export const truncateForLLM = (text: string, opts: TruncateOptions = {}): string => {
  const max = opts.maxChars ?? DEFAULT_MAX;
  if (text.length <= max) return text;
  const ratio = Math.max(0, Math.min(1, opts.headRatio ?? DEFAULT_HEAD_RATIO));
  const headLen = Math.floor(max * ratio);
  const tailLen = max - headLen;
  const elided = text.length - headLen - tailLen;
  const marker = opts.marker
    ? opts.marker(elided)
    : `\n…(${elided.toLocaleString()} chars elided — total ${text.length.toLocaleString()})…\n`;
  // Snap head/tail to line boundaries when possible to avoid mid-line cuts
  // that confuse the model.
  const head = snapToLineEnd(text, headLen);
  const tail = snapToLineStart(text, text.length - tailLen);
  return `${head}${marker}${tail}`;
};

const snapToLineEnd = (s: string, idx: number): string => {
  if (idx >= s.length) return s;
  const nl = s.lastIndexOf('\n', idx);
  if (nl > idx - 200 && nl > 0) return s.slice(0, nl + 1);
  return s.slice(0, idx);
};

const snapToLineStart = (s: string, idx: number): string => {
  if (idx <= 0) return s;
  const nl = s.indexOf('\n', idx);
  if (nl >= 0 && nl < idx + 200) return s.slice(nl + 1);
  return s.slice(idx);
};
