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
});
