import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ok } from '../result.js';
import { toolToSpec, registryToSpecs } from './tool-spec.js';
import { ToolRegistry, type Tool } from '../tools/index.js';

const sample: Tool<{ path: string; bytes?: number }> = {
  name: 'sample',
  description: 'A sample tool',
  approval: 'auto',
  schema: z.object({
    path: z.string().min(1),
    bytes: z.number().int().positive().optional()
  }),
  async execute() {
    return ok({ type: 'ok', summary: '' });
  }
};

describe('toolToSpec', () => {
  it('produces an OpenAI-compatible function spec', () => {
    const spec = toolToSpec(sample);
    expect(spec.name).toBe('sample');
    expect(spec.description).toBe('A sample tool');
    expect(spec.parameters).toMatchObject({ type: 'object' });
    const params = spec.parameters as Record<string, unknown>;
    expect((params['properties'] as Record<string, unknown>)['path']).toBeDefined();
    expect(params['$schema']).toBeUndefined();
  });

  it('serializes a whole registry', () => {
    const r = new ToolRegistry();
    r.register(sample);
    const specs = registryToSpecs(r);
    expect(specs.map((s) => s.name)).toEqual(['sample']);
  });

  it('flattens top-level discriminatedUnion into a single object schema', () => {
    const unioned: Tool<{ op: 'a' | 'b'; ref?: string; url?: string }> = {
      name: 'multi',
      description: 'union tool',
      approval: 'auto',
      schema: z.discriminatedUnion('op', [
        z.object({ op: z.literal('a'), url: z.string().url() }),
        z.object({ op: z.literal('b'), ref: z.string().min(1) })
      ]),
      async execute() {
        return ok({ type: 'ok', summary: '' });
      }
    };
    const spec = toolToSpec(unioned);
    const params = spec.parameters as Record<string, unknown>;
    // OpenAI rules:
    expect(params['type']).toBe('object');
    expect(params['oneOf']).toBeUndefined();
    expect(params['anyOf']).toBeUndefined();
    expect(params['allOf']).toBeUndefined();
    expect(params['enum']).toBeUndefined();
    expect(params['not']).toBeUndefined();
    const props = params['properties'] as Record<string, unknown>;
    expect(props['op']).toBeDefined();
    expect(props['url']).toBeDefined();
    expect(props['ref']).toBeDefined();
    // `op` is shared by all branches with different consts -> collapse to enum.
    const opSchema = props['op'] as Record<string, unknown>;
    expect(opSchema['enum']).toEqual(['a', 'b']);
    // `op` appears in every branch's `required`, so it stays required.
    expect(params['required']).toContain('op');
    // `url`/`ref` only appear in one branch each, so they must NOT be required.
    expect(params['required']).not.toContain('url');
    expect(params['required']).not.toContain('ref');
  });
});
