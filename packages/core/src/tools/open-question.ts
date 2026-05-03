/**
 * Built-in tool: open_question
 *
 * Captures a genuine ambiguity the agent encountered (a missing
 * requirement, an undocumented edge case, a value that depends on
 * external context the agent doesn't have) and appends it to
 * `context/progress-tracker.md` under the "## Open Questions"
 * heading.
 *
 * The tool is the formal "don't invent product behavior — escalate"
 * channel called out in `context/ai-workflow-rules.md`. It complements
 * `clarify` (which interrupts the current turn for an answer) by
 * being asynchronous: the agent records the question and continues
 * with what it can do, leaving the user to resolve it later.
 *
 * Best-effort:
 *  - Returns `TOOL_EXECUTION_FAILED` if `context/progress-tracker.md`
 *    doesn't exist (i.e., the Six-File Context Pack hasn't been
 *    scaffolded yet — the agent should call `clarify` instead).
 *  - Deduplicates: identical question text is a no-op.
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atlasError } from '../errors.js';
import { err, ok } from '../result.js';
import type { Tool } from './types.js';

const TRACKER_REL = 'context/progress-tracker.md';
const HEADING = '## Open Questions';

const Input = z.object({
  question: z.string().min(8).max(400),
  /** Optional context — one short sentence about why this matters now. */
  context: z.string().max(400).optional()
});

const escapeForRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const appendUnderHeading = (existing: string, line: string): string => {
  const idx = existing.indexOf(HEADING);
  if (idx < 0) return existing;
  const afterHeading = existing.indexOf('\n', idx);
  if (afterHeading < 0) return existing;
  let insertAt = afterHeading + 1;
  while (insertAt < existing.length) {
    const eol = existing.indexOf('\n', insertAt);
    const lineSlice = existing.slice(insertAt, eol < 0 ? existing.length : eol);
    if (lineSlice.startsWith('> ') || lineSlice.trim() === '') {
      insertAt = (eol < 0 ? existing.length : eol) + 1;
      continue;
    }
    // If the next non-blank line is the literal placeholder
    // "_None._" (with surrounding markdown emphasis), replace it
    // instead of inserting above it.
    if (/^_*\s*none\.?\s*_*$/i.test(lineSlice.trim())) {
      const eolIdx = eol < 0 ? existing.length : eol;
      return `${existing.slice(0, insertAt)}- ${line}\n${existing.slice(eolIdx + 1)}`;
    }
    break;
  }
  return `${existing.slice(0, insertAt)}- ${line}\n${existing.slice(insertAt)}`;
};

export const openQuestionTool: Tool<z.infer<typeof Input>> = {
  name: 'open_question',
  description:
    'Append an unresolved ambiguity to context/progress-tracker.md so the user can answer it later.',
  approval: 'auto',
  schema: Input,
  whenToUse:
    "Reach for this when you encounter a genuine product/spec ambiguity that you must NOT guess on (a missing requirement, an undocumented edge case, a value depending on external context) AND the user is not actively waiting for an answer. Use `clarify` instead when the answer changes what you do in THIS turn. Do NOT use this for low-stakes guesses you can make sensibly yourself, and do NOT use it as a notes/scratchpad — it's a queue the user reads.",
  outputContract:
    "On success, `summary` is `logged: <question (truncated 120 chars)>`. `data` carries `{question, context, file, alreadyLogged}`.",
  blockedOps: [
    'context/progress-tracker.md does not exist (returns TOOL_EXECUTION_FAILED — scaffold the Six-File Context Pack first)',
    'tracker has no `## Open Questions` heading (returns TOOL_EXECUTION_FAILED)'
  ],
  examples: [
    {
      input: '{"question":"Should the read_file cache persist across sessions to ~/.atlas/cache/?"}',
      result: 'appends a bullet under Open Questions in context/progress-tracker.md'
    },
    {
      input: '{"question":"What is the retention policy for session transcripts?","context":"PRD says they persist; no max age specified."}',
      result: 'appends a bullet plus the context fragment'
    }
  ],
  async execute(input, ctx) {
    if (ctx.signal?.aborted) {
      return err(atlasError('TOOL_CANCELLED', 'open_question cancelled'));
    }
    const trackerAbs = join(ctx.cwd, TRACKER_REL);
    try {
      const s = await stat(trackerAbs);
      if (!s.isFile()) {
        return err(
          atlasError(
            'TOOL_EXECUTION_FAILED',
            `${TRACKER_REL} not found — scaffold the Six-File Context Pack first (athena *scaffold-context-pack)`
          )
        );
      }
    } catch {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          `${TRACKER_REL} not found — scaffold the Six-File Context Pack first (athena *scaffold-context-pack)`
        )
      );
    }

    let existing: string;
    try {
      existing = await readFile(trackerAbs, 'utf8');
    } catch (e) {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          `failed to read ${TRACKER_REL}: ${e instanceof Error ? e.message : String(e)}`
        )
      );
    }

    const trimmedQ = input.question.trim();
    const trimmedC = input.context?.trim();
    const composed = trimmedC ? `${trimmedQ} _(${trimmedC})_` : trimmedQ;

    // Dedupe: identical question text already present anywhere in the file.
    const re = new RegExp(`-\\s+${escapeForRegex(trimmedQ)}\\b`);
    if (re.test(existing)) {
      const preview =
        trimmedQ.length > 120 ? `${trimmedQ.slice(0, 120)}\u2026` : trimmedQ;
      return ok({
        type: 'ok',
        summary: `already logged: ${preview}`,
        data: {
          question: trimmedQ,
          context: trimmedC,
          file: TRACKER_REL,
          alreadyLogged: true
        }
      });
    }

    const next = appendUnderHeading(existing, composed);
    if (next === existing) {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          `${TRACKER_REL} has no "${HEADING}" heading — add it or use \`clarify\` instead`
        )
      );
    }

    try {
      await writeFile(trackerAbs, next, 'utf8');
    } catch (e) {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          `failed to write ${TRACKER_REL}: ${e instanceof Error ? e.message : String(e)}`
        )
      );
    }

    const preview =
      trimmedQ.length > 120 ? `${trimmedQ.slice(0, 120)}\u2026` : trimmedQ;
    return ok({
      type: 'ok',
      summary: `logged: ${preview}`,
      data: {
        question: trimmedQ,
        context: trimmedC,
        file: TRACKER_REL,
        alreadyLogged: false
      }
    });
  }
};
