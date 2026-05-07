/**
 * Convert Atlas `Tool` definitions into the OpenAI/OpenRouter `ToolSpec`
 * wire format. Uses zod-to-json-schema for accurate JSON Schema output.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import { composeToolDescription, type Tool } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolSpec } from './types.js';

type JsonObject = Record<string, unknown>;

/**
 * OpenAI's function-call schema validator is strict:
 *
 *   "schema must have type 'object' and not have
 *    'oneOf'/'anyOf'/'allOf'/'enum'/'not' at the top level."
 *
 * Zod `discriminatedUnion` (and plain `union`) emit `oneOf`/`anyOf` with no
 * top-level `type`, which trips both rules. We flatten the union into a
 * single permissive `object` schema by merging every branch's properties
 * together. The model still sees the discriminator (e.g. `op`) as an enum
 * of the literal values, and Zod re-validates the actual call at runtime,
 * so we don't lose any safety — we just relax the wire schema enough for
 * OpenAI/Codex to accept it.
 */
const flattenTopLevelUnion = (schema: JsonObject): JsonObject => {
  const variants =
    (Array.isArray(schema['oneOf']) && (schema['oneOf'] as unknown[])) ||
    (Array.isArray(schema['anyOf']) && (schema['anyOf'] as unknown[])) ||
    null;
  if (!variants || variants.length === 0) return schema;

  const mergedProps: JsonObject = {};
  const requiredCounts = new Map<string, number>();
  let branchCount = 0;

  for (const v of variants) {
    if (!v || typeof v !== 'object') continue;
    const branch = v as JsonObject;
    branchCount += 1;
    const props = (branch['properties'] as JsonObject | undefined) ?? {};
    for (const [key, val] of Object.entries(props)) {
      if (!(key in mergedProps)) {
        mergedProps[key] = val;
        continue;
      }
      // Same property in multiple branches — collapse literal `const`s
      // (and existing `enum`s) into a single `enum` so the discriminator
      // is still expressive.
      const existing = mergedProps[key] as JsonObject;
      const a = existing && typeof existing === 'object' ? existing : {};
      const b = val && typeof val === 'object' ? (val as JsonObject) : {};
      const aValues: unknown[] = Array.isArray(a['enum'])
        ? (a['enum'] as unknown[])
        : 'const' in a
          ? [a['const']]
          : [];
      const bValues: unknown[] = Array.isArray(b['enum'])
        ? (b['enum'] as unknown[])
        : 'const' in b
          ? [b['const']]
          : [];
      if (aValues.length > 0 && bValues.length > 0) {
        const merged: JsonObject = {
          ...a,
          enum: Array.from(new Set([...aValues, ...bValues]))
        };
        delete merged['const'];
        mergedProps[key] = merged;
      }
    }
    const req = Array.isArray(branch['required']) ? (branch['required'] as string[]) : [];
    for (const r of req) requiredCounts.set(r, (requiredCounts.get(r) ?? 0) + 1);
  }

  // Only keep `required` entries shared by ALL branches — anything else is
  // optional from the union's perspective.
  const required = [...requiredCounts.entries()]
    .filter(([, n]) => n === branchCount)
    .map(([k]) => k);

  const flattened: JsonObject = {
    type: 'object',
    properties: mergedProps,
    additionalProperties: false
  };
  if (required.length > 0) flattened['required'] = required;
  if (typeof schema['description'] === 'string') {
    flattened['description'] = schema['description'];
  }
  return flattened;
};

export const toolToSpec = (tool: Tool<unknown>): ToolSpec => {
  const schema = zodToJsonSchema(tool.schema, {
    // Use jsonSchema7 (not openApi3) so we emit standard JSON Schema without
    // OpenAPI-specific extensions like `nullable: true`, which Anthropic
    // rejects (requires JSON Schema draft 2020-12 compatibility).
    target: 'jsonSchema7',
    $refStrategy: 'none'
  }) as JsonObject;
  // Strip top-level $schema — some providers reject it.
  const { $schema: _drop, ...rawSchema } = schema;
  void _drop;

  // 1. Flatten top-level oneOf/anyOf into a single object schema.
  const noUnion = flattenTopLevelUnion(rawSchema);
  // 2. Guarantee top-level `type: "object"` (covers schemas that were
  //    neither unions nor explicit objects, e.g. an empty input).
  const withType: JsonObject =
    noUnion['type'] === 'object'
      ? noUnion
      : { type: 'object', ...noUnion };
  // 3. OpenAI/Codex also rejects object schemas that are missing the
  //    `properties` key entirely — even an empty `{}` is fine, but the
  //    field MUST exist:
  //      "object schema missing properties"
  //    MCP-imported tools that take no arguments often hit this.
  const parameters: JsonObject =
    'properties' in withType ? withType : { ...withType, properties: {} };

  return {
    name: tool.name,
    description: composeToolDescription(tool),
    parameters
  };
};

export const registryToSpecs = (registry: ToolRegistry): readonly ToolSpec[] =>
  registry.list().map(toolToSpec);

