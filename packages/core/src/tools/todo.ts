/**
 * Built-in tool: todo
 *
 * Single read/write entry point. With no `todos` field, returns the
 * current list. With `todos`, replaces (default) or merges by id.
 * State lives on `ctx.todoStore` (one per session).
 *
 * Port of Hermes' todo tool — same shape, same status enum, same
 * "list-position is priority, only one in_progress at a time"
 * convention. Behavioral guidance is in the schema description so it
 * stays cached as part of the static tool spec.
 */
import { z } from 'zod';
import { atlasError } from '../errors.js';
import { err, ok } from '../result.js';
import { summarize } from './todo-store.js';
import type { Tool } from './types.js';

const Item = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled'])
});

const Input = z.object({
  todos: z.array(Item).optional(),
  merge: z.boolean().default(false)
});

export const todoTool: Tool<z.infer<typeof Input>> = {
  name: 'todo',
  description:
    'Manage your task list for the current session. Call with no params to read; pass `todos` to write.',
  approval: 'auto',
  schema: Input,
  whenToUse:
    'Use when the user gives you a multi-step task (3+ steps), when you decompose work yourself, or when you want to show the user a plan before executing. Call with no parameters to read; pass `todos` to replace the list (or `merge:true` to update by id). Mark exactly one item `in_progress` at a time, mark items `completed` immediately when done, `cancelled` if you abandon them.',
  outputContract:
    'On success, `summary` is `<n> todos: <pending>p / <in_progress>i / <completed>c / <cancelled>x`. `data` carries `{todos, summary}` where `summary` has `{total, pending, in_progress, completed, cancelled}`.',
  blockedOps: [
    'invalid status values (rejected by schema)',
    'duplicate ids (last occurrence wins on write)'
  ],
  examples: [
    {
      input: '{}',
      result: 'returns the current task list'
    },
    {
      input:
        '{"todos":[{"id":"1","content":"add SSRF guard","status":"in_progress"},{"id":"2","content":"add web tool","status":"pending"}]}',
      result: 'replaces the list with two items'
    },
    {
      input: '{"todos":[{"id":"1","content":"add SSRF guard","status":"completed"}],"merge":true}',
      result: 'updates item 1 to completed, leaves the rest alone',
      note: 'Use `merge:true` for incremental status flips so you do not have to re-send the full list every time.'
    }
  ],
  async execute(input, ctx) {
    if (!ctx.todoStore) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', 'todo tool: no TodoStore on ToolContext')
      );
    }
    const items = input.todos
      ? ctx.todoStore.write(input.todos, input.merge)
      : ctx.todoStore.read();
    const s = summarize(items);
    const summary = `${s.total} todos: ${s.pending}p / ${s.in_progress}i / ${s.completed}c / ${s.cancelled}x`;
    return ok({ type: 'ok', summary, data: { todos: items, summary: s } });
  }
};
