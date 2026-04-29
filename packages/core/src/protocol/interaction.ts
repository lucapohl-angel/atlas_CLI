/**
 * Structured-question protocol — a way for agents to ask the user a
 * specific question with optional pre-suggested answers, while keeping
 * the conversation in plain text/markdown.
 *
 * Wire format embedded inside an assistant message:
 *
 *   <atlas:question>
 *   prompt: pick a database
 *   - SQLite (embedded, easy to ship)
 *   - PostgreSQL (production-grade)
 *   - DuckDB (analytics)
 *   freeform: true
 *   </atlas:question>
 *
 * Parser is deliberately tolerant — XML tag fences only, simple
 * key/value plus `- ` option lines. Streaming-safe: callers feed deltas
 * incrementally and check `tryExtract()` after each delta.
 */

export interface InteractionOption {
  readonly label: string;
  readonly value: string;
}

export interface InteractionRequest {
  readonly prompt: string;
  readonly options: readonly InteractionOption[];
  readonly allowFreeform: boolean;
}

const OPEN_TAG = '<atlas:question>';
const CLOSE_TAG = '</atlas:question>';

/**
 * Parse a single `<atlas:question>...</atlas:question>` block.
 * Returns `null` if the body is malformed.
 */
export const parseInteractionBlock = (body: string): InteractionRequest | null => {
  const lines = body.split(/\r?\n/);
  let prompt = '';
  let allowFreeform = true;
  const options: InteractionOption[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('- ')) {
      const label = line.slice(2).trim();
      if (label.length > 0) options.push({ label, value: label });
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'prompt' || key === 'question') prompt = value;
    else if (key === 'freeform' || key === 'allow_freeform') {
      allowFreeform = value !== 'false' && value !== '0' && value !== 'no';
    }
  }
  if (!prompt) return null;
  return { prompt, options, allowFreeform };
};

/**
 * Find and extract the first complete `<atlas:question>...</atlas:question>`
 * block in the supplied text. Returns the parsed request plus the text
 * with the block removed (so callers can continue rendering the surrounding
 * narrative).
 *
 * Returns `null` if no complete block is present yet (still streaming).
 */
export const tryExtractInteraction = (
  text: string
): { readonly request: InteractionRequest; readonly remaining: string } | null => {
  const start = text.indexOf(OPEN_TAG);
  if (start < 0) return null;
  const after = start + OPEN_TAG.length;
  const end = text.indexOf(CLOSE_TAG, after);
  if (end < 0) return null;
  const body = text.slice(after, end);
  const req = parseInteractionBlock(body);
  if (!req) return null;
  const remaining =
    text.slice(0, start) + text.slice(end + CLOSE_TAG.length);
  return { request: req, remaining };
};

/**
 * Default instructions appended to every agent's system prompt so the
 * model knows how to ask structured questions when it wants user input.
 */
export const renderInteractionInstructions = (): string =>
  [
    '## Asking the user a question',
    '',
    'When you need user input, you MAY embed exactly one structured-question block:',
    '',
    '    <atlas:question>',
    '    prompt: <your question>',
    '    - <suggested option 1>',
    '    - <suggested option 2>',
    '    - <suggested option 3>',
    '    freeform: true',
    '    </atlas:question>',
    '',
    'Suggest 0–3 short concrete options. Use `freeform: false` only when an open answer would be unhelpful. The user can always type their own answer unless you set freeform to false.',
    '',
    'Ask as many questions as you genuinely need to understand the goal — there is no cap. Prefer one focused question per turn.'
  ].join('\n');
