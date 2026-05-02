/**
 * Built-in tool: clarify
 *
 * Lets the model ask the user a structured question — either with up
 * to four predefined choices (the UI appends a 5th "Other" option) or
 * open-ended. The actual interaction is delegated to a host-supplied
 * `ctx.clarifyAsk` callback so this tool stays UI-agnostic.
 *
 * Port of Hermes' clarify tool. Same MAX_CHOICES=4, same "fall back
 * to open-ended when choices array is empty" rule.
 */
import { z } from 'zod';
import { atlasError } from '../errors.js';
import { err, ok } from '../result.js';
import type { Tool } from './types.js';

const MAX_CHOICES = 4;

const Input = z.object({
  question: z.string().min(1),
  choices: z.array(z.string().min(1)).max(MAX_CHOICES).optional()
});

export const clarifyTool: Tool<z.infer<typeof Input>> = {
  name: 'clarify',
  description: 'Ask the user a structured question. Up to 4 choices, or omit choices for open-ended.',
  approval: 'auto',
  schema: Input,
  whenToUse:
    "Reach for this when the task is genuinely ambiguous and the answer changes what you do next: pick between two architectures, confirm a destructive intent the user expressed loosely, choose a model/provider, accept or reject a learned skill. Do NOT use this for low-stakes decisions you can make sensibly yourself, and do NOT use it as a replacement for the per-tool approval prompt (that one fires on its own when you call dangerous tools).",
  outputContract:
    "On success, `summary` is `user: <answer>` (truncated to 200 chars). `data` carries `{question, choices, answer}`.",
  blockedOps: [
    'more than 4 choices (rejected by schema)',
    'no host clarify callback registered (returns TOOL_EXECUTION_FAILED)'
  ],
  examples: [
    {
      input: '{"question":"Use Tavily or Exa for web search?","choices":["Tavily","Exa"]}',
      result: 'prompts the user with two options + Other; returns the chosen answer'
    },
    {
      input: '{"question":"What metric should I optimise for?"}',
      result: 'open-ended free-text answer'
    }
  ],
  async execute(input, ctx) {
    if (!ctx.clarifyAsk) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', 'clarify tool: host did not provide a clarifyAsk callback')
      );
    }
    if (ctx.signal?.aborted) {
      return err(atlasError('TOOL_CANCELLED', 'clarify cancelled'));
    }
    const choices = input.choices && input.choices.length > 0 ? input.choices : undefined;
    let answer: string;
    try {
      answer = await ctx.clarifyAsk(input.question.trim(), choices, ctx.signal);
    } catch (e) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `clarify callback failed: ${e instanceof Error ? e.message : String(e)}`)
      );
    }
    const trimmed = String(answer ?? '').trim();
    const preview = trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed;
    return ok({
      type: 'ok',
      summary: `user: ${preview}`,
      data: { question: input.question, choices, answer: trimmed }
    });
  }
};
