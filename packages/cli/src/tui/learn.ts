/**
 * Self-improvement loop helpers — the learned-skill auto-creation
 * feature used by the TUI.
 *
 * The flow is:
 *
 *   1. If auto-learn is enabled, App.tsx runs
 *      `shouldOfferLearn(rounds, errors, user)` after each turn.
 *   2. If true, App.tsx calls a small reflection sub-call against the
 *      active provider with `buildReflectionMessages(...)`. The model is
 *      asked to either output a draft `LearnedSkillDraft` JSON or `null`.
 *   3. App.tsx parses the response with `parseLearnedSkillDraft`.
 *   4. If a draft was produced, App.tsx shows the `learn-confirm` overlay
 *      so the user can Save / Edit / Discard.
 *
 * Token cost is bounded: the reflection sub-call is gated behind the
 * heuristic and reuses the active provider's `stream` API for a single
 * non-tool round-trip.
 */
import type { Message } from '@atlas/core';

/**
 * Auto-learn starts on, but the heuristic below is deliberately stingy:
 * normal multi-tool chores should not become learned skills.
 */
export const DEFAULT_AUTO_LEARN_ENABLED = true;

const LONG_TURN_ROUNDS = 8;
const RECOVERY_ROUNDS = 5;
const SUCCESS_AFTER_STRUGGLE_ROUNDS = 3;
const REPEATED_TOOL_ERRORS = 2;

/** Phrases that suggest the user just unblocked something hard. */
const SUCCESS_PHRASES: readonly string[] = [
  'works now',
  'finally works',
  'finally got',
  'got it working',
  'fixed it',
  'thanks that worked',
  'that worked',
  'perfect, that',
  'nailed it'
];

/**
 * Heuristic gate: was this turn "hard enough" to be worth distilling?
 *
 *  - rounds ≥ 8  → genuinely long debugging / refactor turn
 *  - tool errors ≥ 2 → the agent stumbled and recovered
 *  - rounds ≥ 5 plus a tool error → non-trivial recovery
 *  - the user message contains a success phrase after a struggle (≥ 3 rounds)
 */
export const shouldOfferLearn = (
  rounds: number,
  toolErrors: number,
  lastUserMessage: string
): boolean => {
  const hasSuccessSignal = SUCCESS_PHRASES.some((p) =>
    lastUserMessage.toLowerCase().includes(p)
  );
  if (toolErrors >= REPEATED_TOOL_ERRORS) return true;
  if (rounds >= LONG_TURN_ROUNDS) return true;
  if (rounds >= RECOVERY_ROUNDS && toolErrors > 0) return true;
  if (rounds >= SUCCESS_AFTER_STRUGGLE_ROUNDS && hasSuccessSignal) return true;
  return false;
};

const shouldMentionRounds = (
  rounds: number,
  toolErrors: number,
  hasSuccessSignal: boolean
): boolean =>
  rounds >= LONG_TURN_ROUNDS ||
  (rounds >= RECOVERY_ROUNDS && toolErrors > 0) ||
  (rounds >= SUCCESS_AFTER_STRUGGLE_ROUNDS && hasSuccessSignal);

/** One-line "why" string shown to the user on the confirmation overlay. */
export const describeLearnReason = (
  rounds: number,
  toolErrors: number,
  lastUserMessage: string
): string => {
  const reasons: string[] = [];
  const lower = lastUserMessage.toLowerCase();
  const hasSuccessSignal = SUCCESS_PHRASES.some((p) => lower.includes(p));

  if (shouldMentionRounds(rounds, toolErrors, hasSuccessSignal)) {
    reasons.push(`turn took ${rounds} rounds`);
  }
  if (toolErrors >= REPEATED_TOOL_ERRORS) reasons.push(`${toolErrors} tool errors`);
  else if (toolErrors === 1 && rounds >= RECOVERY_ROUNDS) reasons.push('1 tool recovery');
  if (rounds >= SUCCESS_AFTER_STRUGGLE_ROUNDS && hasSuccessSignal) {
    reasons.push('user signalled success');
  }
  return reasons.length > 0 ? reasons.join(', ') : 'manual /learn';
};

/**
 * System prompt for the reflection sub-call. Deliberately strict: the
 * model must output a single JSON object on its own line, OR the literal
 * string `null` if there's nothing reusable. No prose.
 */
const REFLECTION_SYSTEM = `You are a meta-learning agent for Atlas CLI. Your job is to look at the recent conversation and decide whether there is a procedurally reusable lesson — a recipe that a future agent could follow to avoid the same dance — and if so, distill it into a SKILL.md.

Return EXACTLY ONE of:

(a) A JSON object on a single line with this shape:
{"name":"short-kebab-case-slug","description":"one sentence under 120 chars","triggers":["substring1","substring2"],"body":"# Markdown\\n\\n## Steps\\n\\n1. ..."}

(b) The literal token: null

Rules:
- Slug ≤ 60 chars, lowercase, kebab-case, descriptive.
- Triggers are substrings (case-insensitive) that, when present in a future user message, would make this skill relevant. Provide 2-5.
- Body is markdown. Concrete steps, not theory. Include exact commands / file paths / code where applicable. Strip secrets.
- If the turn was just a normal Q&A, banter, or trivial fix that no one would benefit from being reminded of — return null.
- Never invent steps that didn't actually appear in the transcript.
- Output ONLY the JSON or the word null. No prose, no markdown fences, no explanation.`;

/**
 * Build the message list for the reflection sub-call.
 * We send the last `recentTurnsCap` messages, dropping system messages
 * (the reflection has its own), and trimming each message to a hard
 * char cap so a runaway transcript doesn't blow up the prompt.
 */
export const buildReflectionMessages = (
  history: readonly Message[],
  reason: string,
  options: {
    readonly recentTurnsCap?: number;
    readonly perMessageCharCap?: number;
    /**
     * When true, the reflection sub-call is told to ALWAYS emit a JSON
     * draft — even for trivial turns. Surfaces via `/learn force`. The
     * model is instructed to capture *something* reusable from the
     * transcript instead of returning the `null` decline token.
     */
     readonly force?: boolean;
  } = {}
): Message[] => {
  const capN = options.recentTurnsCap ?? 16;
  const capChars = options.perMessageCharCap ?? 1500;
  const trim = (content: string): string =>
    content.length > capChars
      ? `${content.slice(0, capChars)}\n…[truncated]`
      : content;
  const recent = history
    .filter((m) => m.role !== 'system')
    .slice(-capN)
    .flatMap<Message>((m) => {
      if (m.role === 'tool') {
        const label = m.name ? `[tool result: ${m.name}]` : '[tool result]';
        return [{ role: 'user', content: trim(`${label}\n${m.content}`) }];
      }
      if (m.role === 'assistant') {
        const parts: string[] = [];
        if (m.content.trim().length > 0) parts.push(m.content);
        for (const tc of m.toolCalls ?? []) {
          parts.push(`[tool call: ${tc.name}]\n${tc.arguments}`);
        }
        const content = parts.join('\n\n').trim();
        return content.length > 0 ? [{ role: 'assistant', content: trim(content) }] : [];
      }
      return [{ role: 'user', content: trim(m.content) }];
    });
  const summary: Message = {
    role: 'user',
    content: options.force
      ? `[meta] The user invoked \`/learn force\`. Reflect on the conversation above and produce a SKILL.md JSON draft NO MATTER WHAT — the user has decided this turn is worth distilling, even if it was short. Trigger reason: ${reason}.\n\nDo NOT return \`null\`. Capture whatever recipe / pattern / verification steps appeared in the transcript, even if minimal. Output ONLY the JSON object.`
      : `[meta] Reflect on the conversation above. Trigger reason: ${reason}.\n\nNow output the JSON skill draft, or the literal token \`null\`.`
  };
  return [
    { role: 'system', content: REFLECTION_SYSTEM },
    ...recent,
    summary
  ];
};

export interface LearnedSkillDraft {
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly body: string;
}

/**
 * Build a revision prompt for an already-proposed skill. Used when the
 * user likes the direction but wants the draft changed before saving.
 */
export const buildSkillRevisionMessages = (
  draft: LearnedSkillDraft,
  changeRequest: string,
  reason: string
): Message[] => [
  { role: 'system', content: REFLECTION_SYSTEM },
  {
    role: 'user',
    content:
      `[meta] Revise this learned-skill draft. Keep what is good, apply the user's requested change, and return the full revised JSON object.\n\n` +
      `Original trigger reason: ${reason}\n\n` +
      `Current draft JSON:\n${JSON.stringify(draft)}\n\n` +
      `User requested change:\n${changeRequest}\n\n` +
      'Output ONLY the revised JSON object. Do not return null unless the requested change explicitly says to discard the skill.'
  }
];

/**
 * Parse the reflection response. Returns the draft, `null` if the model
 * declined (literal `null` token), or a string error message.
 */
export const parseLearnedSkillDraft = (
  raw: string
): { ok: true; draft: LearnedSkillDraft | null } | { ok: false; error: string } => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: 'empty reflection response' };
  if (trimmed === 'null' || trimmed.toLowerCase() === 'null') {
    return { ok: true, draft: null };
  }
  // Be tolerant: some models wrap the JSON in a fenced block despite
  // the instruction. Strip leading/trailing fences if present.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  if (parsed === null) return { ok: true, draft: null };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'reflection JSON was not an object' };
  }
  const obj = parsed as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  const triggers = Array.isArray(obj.triggers)
    ? obj.triggers.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];
  const body = typeof obj.body === 'string' ? obj.body.trim() : '';
  if (name.length === 0 || description.length === 0 || body.length === 0) {
    return { ok: false, error: 'draft missing required fields (name/description/body)' };
  }
  return {
    ok: true,
    draft: { name, description, triggers, body }
  };
};
