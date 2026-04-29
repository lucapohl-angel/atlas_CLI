/**
 * Tiny static pricing table for popular OpenRouter / Anthropic models so
 * the TUI can show a real-time cost estimate next to the token counter.
 *
 * Prices are USD per **million** tokens, taken from the public pricing
 * pages at the time of writing. They are deliberately approximate — the
 * goal is to give the user a useful sense of "this conversation cost
 * roughly $X", not an audit-grade invoice. When in doubt the table
 * under-estimates by falling back to a conservative blended rate.
 *
 * Lookup is forgiving: the model id is normalized (lowercase, prefix
 * stripped) and matched against the longest known prefix. Returns
 * `undefined` when no entry applies — callers should hide the cost
 * indicator in that case rather than show "$0.00".
 */
export interface ModelPrice {
  /** USD per 1,000,000 input tokens. */
  readonly inputPerMTok: number;
  /** USD per 1,000,000 output tokens. */
  readonly outputPerMTok: number;
}

// Keys must be matched as longest-prefix-wins. Order doesn't matter.
const PRICES: Readonly<Record<string, ModelPrice>> = {
  // Anthropic (native + openrouter mirrors)
  'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-3-5-sonnet': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-3-5-haiku': { inputPerMTok: 0.8, outputPerMTok: 4 },
  'claude-3-opus': { inputPerMTok: 15, outputPerMTok: 75 },
  // OpenAI
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'gpt-4.1-mini': { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  'gpt-4.1': { inputPerMTok: 2, outputPerMTok: 8 },
  'o1-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  'o1': { inputPerMTok: 15, outputPerMTok: 60 },
  'o3-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  // Google
  'gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  'gemini-2.0-flash': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  // DeepSeek / Mistral / xAI / Moonshot — common OpenRouter favorites
  'deepseek-chat': { inputPerMTok: 0.14, outputPerMTok: 0.28 },
  'deepseek-r1': { inputPerMTok: 0.55, outputPerMTok: 2.19 },
  'mistral-large': { inputPerMTok: 2, outputPerMTok: 6 },
  'mistral-small': { inputPerMTok: 0.2, outputPerMTok: 0.6 },
  'grok-4': { inputPerMTok: 5, outputPerMTok: 15 },
  'grok-3': { inputPerMTok: 3, outputPerMTok: 15 },
  'kimi-k2': { inputPerMTok: 0.6, outputPerMTok: 2.5 }
};

/**
 * Normalize a model id for lookup. Strips the `provider/` slug used by
 * OpenRouter so anthropic native ids and openrouter ids hit the same
 * table entries. Also drops version date suffixes like `-20250514`.
 */
const normalize = (modelId: string): string => {
  const lower = modelId.toLowerCase();
  const slash = lower.lastIndexOf('/');
  const stripped = slash >= 0 ? lower.slice(slash + 1) : lower;
  return stripped.replace(/-2\d{7}$/, '');
};

export const priceForModel = (modelId: string): ModelPrice | undefined => {
  const key = normalize(modelId);
  // Exact match first
  if (PRICES[key]) return PRICES[key];
  // Longest-prefix match
  let best: { len: number; price: ModelPrice } | null = null;
  for (const [prefix, price] of Object.entries(PRICES)) {
    if (key.startsWith(prefix) && (best === null || prefix.length > best.len)) {
      best = { len: prefix.length, price };
    }
  }
  return best?.price;
};

/**
 * USD cost for a usage record, or `undefined` when the model is unknown.
 */
export const estimateCost = (
  modelId: string,
  promptTokens: number,
  completionTokens: number
): number | undefined => {
  const p = priceForModel(modelId);
  if (!p) return undefined;
  return (
    (promptTokens * p.inputPerMTok) / 1_000_000 +
    (completionTokens * p.outputPerMTok) / 1_000_000
  );
};

/**
 * Format a USD amount for the status bar — picks a reasonable precision
 * for the magnitude. Sub-cent costs show 4 decimals so the user sees
 * progress; larger costs round to cents.
 */
export const formatCost = (usd: number): string => {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
};
