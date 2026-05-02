/**
 * Convert Atlas `Tool` definitions into the OpenAI/OpenRouter `ToolSpec`
 * wire format. Uses zod-to-json-schema for accurate JSON Schema output.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import { composeToolDescription, type Tool, type ToolRegistry } from '../tools/index.js';
import type { ToolSpec } from './types.js';

export const toolToSpec = (tool: Tool<unknown>): ToolSpec => {
  const schema = zodToJsonSchema(tool.schema, {
    // Use jsonSchema7 (not openApi3) so we emit standard JSON Schema without
    // OpenAPI-specific extensions like `nullable: true`, which Anthropic
    // rejects (requires JSON Schema draft 2020-12 compatibility).
    target: 'jsonSchema7',
    $refStrategy: 'none'
  }) as Record<string, unknown>;
  // Strip top-level $schema — some providers reject it.
  const { $schema: _drop, ...rawSchema } = schema;
  void _drop;
  // OpenAI/Codex requires parameters.type === "object". Zod discriminated
  // unions emit a top-level oneOf without a type field — providers reject
  // this with HTTP 400 ("type: None"). Inject type:'object' when absent so
  // the wire schema is always valid. The model still uses oneOf/anyOf for
  // generation, so this does not change call semantics.
  const parameters: Record<string, unknown> =
    'type' in rawSchema ? rawSchema : { type: 'object', ...rawSchema };
  return {
    name: tool.name,
    description: composeToolDescription(tool),
    parameters
  };
};

export const registryToSpecs = (registry: ToolRegistry): readonly ToolSpec[] =>
  registry.list().map(toolToSpec);
