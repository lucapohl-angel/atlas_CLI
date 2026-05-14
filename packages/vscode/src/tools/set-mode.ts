import { z } from 'zod';
import { ok } from '@atlas/core/result';
import type { Tool } from '@atlas/core/tools/types';

const SetModeInputSchema = z.object({
  mode: z.enum(['plan', 'build', 'autopilot']),
  reason: z.string().optional(),
}).strict();

export const createSetModeTool = (
  onSetMode: (mode: 'plan' | 'build' | 'autopilot') => void,
): Tool<z.infer<typeof SetModeInputSchema>> => ({
  name: 'set_mode',
  description: 'Change Atlas execution mode. plan=read-only advisory, build=full tool access with approval, autopilot=auto-approve all tools. Use when the user asks to switch modes or when the agent determines a different mode is appropriate for the current task.',
  schema: SetModeInputSchema,
  approval: 'auto',
  async execute(input) {
    onSetMode(input.mode);
    const reasonText = input.reason ? ` (${input.reason})` : '';
    return ok({
      type: 'ok',
      summary: `Mode changed to ${input.mode}${reasonText}`,
      data: { mode: input.mode },
    });
  },
});
