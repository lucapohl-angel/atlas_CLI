/**
 * Checklist type definitions. A checklist is a YAML file declaring a set
 * of binary pass/fail items that an agent verifies against an artifact
 * before declaring a piece of work "ready" or "done".
 *
 * Atlas checklists are the structural counterpart to templates:
 *   - Templates gate creation ("fill in these required fields").
 *   - Checklists gate review ("verify these conditions hold").
 *
 * The engine surfaces items + structure to the agent and aggregates the
 * agent's verdicts; it does not auto-evaluate semantic items.
 */
import { z } from 'zod';

const Identifier = z.string().regex(/^[a-z][a-z0-9-]*$/, 'use kebab-case identifiers');

export const ChecklistSeveritySchema = z.enum(['blocker', 'warning', 'info']);
export type ChecklistSeverity = z.infer<typeof ChecklistSeveritySchema>;

export const ChecklistItemSchema = z.object({
  id: Identifier,
  text: z.string().min(1),
  severity: ChecklistSeveritySchema.default('blocker'),
  /** Optional hint shown to the agent (e.g. how to verify). */
  hint: z.string().optional()
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const ChecklistSchema = z.object({
  id: Identifier,
  version: z.number().int().positive().default(1),
  title: z.string().min(1),
  description: z.string().optional(),
  /** Agent allowed to run this checklist. Omit to allow any caller. */
  owner: Identifier.optional(),
  /** Other agents permitted to run (in addition to owner). */
  editors: z.array(Identifier).optional(),
  /** Default target file/path the checklist evaluates. */
  appliesTo: z.string().optional(),
  /** Human-readable advice on when to run this checklist. */
  whenToUse: z.string().optional(),
  items: z.array(ChecklistItemSchema).min(1)
});
export type Checklist = z.infer<typeof ChecklistSchema> & {
  readonly path: string;
};

export const ChecklistResultStatusSchema = z.enum(['pass', 'fail', 'skip']);
export type ChecklistResultStatus = z.infer<typeof ChecklistResultStatusSchema>;

export const ChecklistItemResultSchema = z.object({
  itemId: z.string(),
  status: ChecklistResultStatusSchema,
  note: z.string().optional()
});
export type ChecklistItemResult = z.infer<typeof ChecklistItemResultSchema>;

export interface ChecklistRunResult {
  readonly checklistId: string;
  readonly version: number;
  readonly target: string | undefined;
  /** Items as presented to the agent, in declaration order. */
  readonly items: readonly ChecklistItem[];
  /** Per-item results in the same order as `items`. */
  readonly results: readonly ChecklistItemResult[];
  readonly counts: {
    readonly pass: number;
    readonly fail: number;
    readonly skip: number;
    readonly blockerFails: number;
    readonly warningFails: number;
  };
  /** `pass` when no blocker item failed; `fail` otherwise. */
  readonly verdict: 'pass' | 'fail';
}
