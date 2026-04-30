/**
 * Self-improvement loop helpers — the "skill auto-creation" feature
 * described in the README's Hermes-comparison section.
 *
 * The flow is:
 *
 *   1. After each turn, App.tsx runs `shouldOfferLearn(rounds, errors, user)`.
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
 *  - rounds ≥ 5  → multi-step debugging / refactor
 *  - tool errors ≥ 2 → the agent stumbled and recovered
 *  - the user message contains a success phrase after a struggle (≥ 3 rounds)
 */
export const shouldOfferLearn = (
  rounds: number,
  toolErrors: number,
  lastUserMessage: string
): boolean => {
  if (rounds >= 5) return true;
  if (toolErrors >= 2) return true;
  const lower = lastUserMessage.toLowerCase();
  if (rounds >= 3 && SUCCESS_PHRASES.some((p) => lower.includes(p))) return true;
  return false;
};

/** One-line "why" string shown to the user on the confirmation overlay. */
export const describeLearnReason = (
  rounds: number,
  toolErrors: number,
  lastUserMessage: string
): string => {
  const reasons: string[] = [];
  if (rounds >= 5) reasons.push(`turn took ${rounds} rounds`);
  if (toolErrors >= 2) reasons.push(`${toolErrors} tool errors`);
  const lower = lastUserMessage.toLowerCase();
  if (SUCCESS_PHRASES.some((p) => lower.includes(p))) reasons.push('user signalled success');
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
  } = {}
): Message[] => {
  const capN = options.recentTurnsCap ?? 16;
  const capChars = options.perMessageCharCap ?? 1500;
  const recent = history
    .filter((m) => m.role !== 'system')
    .slice(-capN)
    .map<Message>((m) => ({
      role: m.role,
      content: m.content.length > capChars
        ? `${m.content.slice(0, capChars)}\n…[truncated]`
        : m.content
    }));
  const summary: Message = {
    role: 'user',
    content: `[meta] Reflect on the conversation above. Trigger reason: ${reason}.\n\nNow output the JSON skill draft, or the literal token \`null\`.`
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
