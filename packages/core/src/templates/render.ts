/**
 * Template renderer. Compiles each section's body with Handlebars,
 * enforces:
 *   - owner check (TEMPLATE_OWNER_MISMATCH)
 *   - elicitation gate (TEMPLATE_INPUT_MISSING when an `elicit: true`
 *     section's referenced inputs are absent)
 *   - conditional sections (skip when `condition` evaluates falsy against
 *     the input bag)
 *   - repeatable sections (rendered once per array entry under the
 *     section id; the entry binds to `item` plus its own keys)
 *
 * Output is a single Markdown string composed of `## <title>` headings
 * (nested H3+ for child sections) followed by the rendered body.
 *
 * No filesystem writes — callers persist the result via `write_file` or
 * `story_update` so the mixed-mode authorization still gates per-section
 * overwrites.
 */
import Handlebars from 'handlebars';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import type {
  RenderedTemplate,
  Template,
  TemplateInput,
  TemplateSection
} from './types.js';

export interface RenderTemplateOptions {
  readonly template: Template;
  readonly inputs: Readonly<Record<string, unknown>>;
  /** Identity of the agent invoking the renderer (for owner enforcement). */
  readonly callingAgent?: { readonly name: string };
}

const HB = Handlebars.create();

// Minimal helper set — kept tiny on purpose so templates remain readable.
HB.registerHelper('eq', (a: unknown, b: unknown) => a === b);
HB.registerHelper('upper', (s: unknown) => String(s ?? '').toUpperCase());
HB.registerHelper('lower', (s: unknown) => String(s ?? '').toLowerCase());
HB.registerHelper('default', (v: unknown, fallback: unknown) =>
  v === undefined || v === null || v === '' ? fallback : v
);

const compileBody = (body: string, scope: Record<string, unknown>): string => {
  const tpl = HB.compile(body, { noEscape: true, strict: false });
  return tpl(scope);
};

const referencedInputs = (body: string): readonly string[] => {
  // Cheap heuristic — enough to fail fast on the obvious case where an
  // `elicit: true` section references {{x}} but x is missing.
  const found = new Set<string>();
  const re = /\{\{\s*(?:#each|#if|#unless)?\s*([a-zA-Z_][\w.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const head = m[1]?.split('.')[0];
    if (head) found.add(head);
  }
  // Drop obvious helpers / control words.
  for (const reserved of ['this', 'else', 'unless', 'if', 'each', '@root']) found.delete(reserved);
  return [...found];
};

const isMissing = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  v === '' ||
  (Array.isArray(v) && v.length === 0);

const evalCondition = (expr: string, scope: Record<string, unknown>): boolean => {
  // Trim and dispatch on supported forms:
  //   - `inputName`                truthy
  //   - `!inputName`               falsy
  //   - `inputName == 'value'`     equals
  //   - `inputName != 'value'`     not equals
  const e = expr.trim();
  const eqMatch = /^([a-zA-Z_][\w.]*)\s*(==|!=)\s*(.+)$/.exec(e);
  if (eqMatch) {
    const [, lhs, op, rhsRaw] = eqMatch;
    const rhs = rhsRaw!.trim().replace(/^['"]|['"]$/g, '');
    const lhsVal = lhs!
      .split('.')
      .reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], scope);
    return op === '==' ? lhsVal === rhs : lhsVal !== rhs;
  }
  const negate = e.startsWith('!');
  const path = (negate ? e.slice(1) : e).trim();
  const val = path
    .split('.')
    .reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], scope);
  const truthy = !isMissing(val) && val !== false;
  return negate ? !truthy : truthy;
};

const renderSection = (
  section: TemplateSection,
  scope: Record<string, unknown>,
  depth: number,
  elicited: string[]
): Result<string, AtlasError> => {
  if (section.condition && !evalCondition(section.condition, scope)) {
    return ok('');
  }

  // Elicitation gate: any `elicit: true` section whose body references an
  // input that is missing/empty is a hard fail. Forces the caller to
  // interview the user before invoking render.
  if (section.elicit) {
    const refs = referencedInputs(section.body);
    const missing = refs.filter((name) => isMissing(scope[name]));
    if (missing.length > 0) {
      return err(
        atlasError(
          'TEMPLATE_INPUT_MISSING',
          `section "${section.id}" requires elicitation; missing input(s): ${missing.join(', ')}`,
          { context: { section: section.id, missing } }
        )
      );
    }
  }

  const heading = `${'#'.repeat(Math.min(2 + depth, 6))} ${section.title}\n\n`;

  const renderOnce = (innerScope: Record<string, unknown>): Result<string, AtlasError> => {
    let body: string;
    try {
      body = compileBody(section.body, innerScope).trim();
    } catch (e) {
      return err(
        atlasError('TEMPLATE_RENDER_FAILED', `handlebars failed for "${section.id}"`, {
          cause: e,
          context: { section: section.id }
        })
      );
    }
    let out = heading + (body.length > 0 ? `${body}\n\n` : `_(empty)_\n\n`);
    for (const child of section.sections ?? []) {
      const r = renderSection(child, innerScope, depth + 1, elicited);
      if (!r.ok) return err(r.error);
      out += r.value;
    }
    return ok(out);
  };

  if (section.repeatable) {
    const items = scope[section.id];
    if (!Array.isArray(items) || items.length === 0) {
      // Repeatable with no items: render the heading once and mark empty.
      // (Not an elicitation failure — empty arrays are legitimate.)
      return ok(`${heading}_(none)_\n\n`);
    }
    let acc = '';
    for (const item of items) {
      const inner = {
        ...scope,
        item,
        ...(typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {})
      };
      const r = renderOnce(inner);
      if (!r.ok) return err(r.error);
      acc += r.value;
    }
    if (section.elicit) elicited.push(section.id);
    return ok(acc);
  }

  const r = renderOnce(scope);
  if (!r.ok) return err(r.error);
  if (section.elicit) elicited.push(section.id);
  return ok(r.value);
};

const validateInputs = (
  declared: readonly TemplateInput[],
  provided: Readonly<Record<string, unknown>>
): Result<void, AtlasError> => {
  for (const input of declared) {
    if (input.required && isMissing(provided[input.name])) {
      return err(
        atlasError(
          'TEMPLATE_INPUT_MISSING',
          `required input "${input.name}" is missing`,
          { context: { input: input.name } }
        )
      );
    }
  }
  return ok(undefined);
};

export const renderTemplate = (
  options: RenderTemplateOptions
): Result<RenderedTemplate, AtlasError> => {
  const { template, inputs, callingAgent } = options;

  if (template.owner && callingAgent && callingAgent.name !== template.owner) {
    const editorOk = template.editors?.includes(callingAgent.name) ?? false;
    if (!editorOk) {
      return err(
        atlasError(
          'TEMPLATE_OWNER_MISMATCH',
          `template "${template.id}" is owned by ${template.owner}; ${callingAgent.name} is not authorized to render it`,
          { context: { template: template.id, owner: template.owner, caller: callingAgent.name } }
        )
      );
    }
  }

  const validated = validateInputs(template.inputs, inputs);
  if (!validated.ok) return err(validated.error);

  const elicited: string[] = [];
  const scope: Record<string, unknown> = { ...inputs };
  let body = '';
  for (const section of template.sections) {
    const r = renderSection(section, scope, 0, elicited);
    if (!r.ok) return err(r.error);
    body += r.value;
  }

  const front = template.preamble
    ? compileBody(template.preamble, scope)
    : `# ${template.title}\n\n` +
      `<!-- generated by atlas: template=${template.id} version=${template.version} -->\n\n`;

  return ok({
    templateId: template.id,
    version: template.version,
    content: front + body.trimEnd() + '\n',
    elicited
  });
};

// ────────────────────────── Sectioned rendering ──────────────────────────
//
// `renderTemplateSection` produces the markdown for a single named section
// (and its nested children) without the template-level preamble or title
// header. Use this with `applySectionToFile` to grow long-form artifacts
// (PRD, architecture) one section at a time, each with fresh inputs.

export interface RenderTemplateSectionOptions extends RenderTemplateOptions {
  /** Section identifier (`id` field). Top-level sections only. */
  readonly sectionId: string;
}

export interface RenderedSection {
  readonly templateId: string;
  readonly version: number;
  readonly sectionId: string;
  readonly content: string;
  readonly elicited: readonly string[];
}

const findTopLevelSection = (
  template: Template,
  sectionId: string
): TemplateSection | undefined =>
  template.sections.find((s) => s.id === sectionId);

export const renderTemplateSection = (
  options: RenderTemplateSectionOptions
): Result<RenderedSection, AtlasError> => {
  const { template, inputs, callingAgent, sectionId } = options;

  if (template.owner && callingAgent && callingAgent.name !== template.owner) {
    const editorOk = template.editors?.includes(callingAgent.name) ?? false;
    if (!editorOk) {
      return err(
        atlasError(
          'TEMPLATE_OWNER_MISMATCH',
          `template "${template.id}" is owned by ${template.owner}; ${callingAgent.name} is not authorized to render it`,
          { context: { template: template.id, owner: template.owner, caller: callingAgent.name } }
        )
      );
    }
  }

  const section = findTopLevelSection(template, sectionId);
  if (!section) {
    return err(
      atlasError(
        'TEMPLATE_SECTION_NOT_FOUND',
        `template "${template.id}" has no top-level section "${sectionId}"`,
        { context: { template: template.id, sectionId } }
      )
    );
  }

  const validated = validateInputs(template.inputs, inputs);
  if (!validated.ok) return err(validated.error);

  const elicited: string[] = [];
  const scope: Record<string, unknown> = { ...inputs };
  const r = renderSection(section, scope, 0, elicited);
  if (!r.ok) return err(r.error);

  return ok({
    templateId: template.id,
    version: template.version,
    sectionId,
    content: r.value.trimEnd() + '\n',
    elicited
  });
};
