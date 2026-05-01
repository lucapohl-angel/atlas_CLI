/**
 * Template type definitions. Atlas templates are a strict superset of the
 * BMAD template idiom: same YAML shape (id/version/owner/output/sections
 * with elicit/condition/repeatable), plus first-class typed inputs and
 * versioning that integrates with Atlas's on-disk newest-wins rule.
 */
import { z } from 'zod';

const Identifier = z.string().regex(/^[a-z][a-z0-9-]*$/, 'use kebab-case identifiers');
const InputName = z.string().regex(/^[a-z][a-z0-9_]*$/, 'use snake_case input names');

export const TemplateInputTypeSchema = z.enum([
  'string',
  'text',
  'number',
  'boolean',
  'list',
  'object'
]);
export type TemplateInputType = z.infer<typeof TemplateInputTypeSchema>;

export const TemplateInputSchema = z.object({
  name: InputName,
  type: TemplateInputTypeSchema,
  description: z.string().optional(),
  required: z.boolean().default(false),
  example: z.unknown().optional()
});
export type TemplateInput = z.infer<typeof TemplateInputSchema>;

export interface TemplateSection {
  readonly id: string;
  readonly title: string;
  readonly instruction?: string;
  readonly elicit?: boolean;
  readonly examples?: readonly string[];
  readonly condition?: string;
  readonly repeatable?: boolean;
  readonly body: string;
  readonly sections?: readonly TemplateSection[];
}

const TemplateSectionBase = z.object({
  id: Identifier,
  title: z.string().min(1),
  instruction: z.string().optional(),
  elicit: z.boolean().optional(),
  examples: z.array(z.string()).optional(),
  condition: z.string().optional(),
  repeatable: z.boolean().optional(),
  body: z.string().default('')
});

export const TemplateSectionSchema: z.ZodType<TemplateSection> = TemplateSectionBase.extend({
  sections: z.lazy(() => z.array(TemplateSectionSchema).optional())
}) as z.ZodType<TemplateSection>;

export const TemplateSchema = z.object({
  id: Identifier,
  version: z.number().int().positive().default(1),
  title: z.string().min(1),
  description: z.string().optional(),
  /** Agent name allowed to render this template. Omit to allow any caller. */
  owner: Identifier.optional(),
  /** Default output path (cwd-relative). Caller may override at render time. */
  output: z.string().optional(),
  /** Other agents permitted to render this template (in addition to owner). */
  editors: z.array(Identifier).optional(),
  inputs: z.array(TemplateInputSchema).default([]),
  /** Human-readable advice on when to invoke this template. */
  whenToUse: z.string().optional(),
  /**
   * Optional Handlebars-compiled preamble emitted verbatim at the very
   * start of the rendered file. When set, the default `# <title>` +
   * generator comment header is suppressed. Use for formats that require
   * something specific at byte 0 (e.g. DESIGN.md's `---` frontmatter).
   */
  preamble: z.string().optional(),
  sections: z.array(TemplateSectionSchema).min(1)
});
export type Template = z.infer<typeof TemplateSchema> & {
  readonly path: string;
};

export interface RenderedTemplate {
  readonly templateId: string;
  readonly version: number;
  readonly content: string;
  readonly elicited: readonly string[];
}
