import { describe, expect, it } from 'vitest';
import { buildProgram } from './app.js';

describe('atlas CLI program', () => {
  it('exposes the atlas name', () => {
    const program = buildProgram();
    expect(program.name()).toBe('atlas');
  });

  it('reports a non-empty version', () => {
    const program = buildProgram();
    expect(program.version()).toMatch(/\d+\.\d+\.\d+/);
  });

  it('registers the doctor subcommand', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('doctor');
  });

  it('registers the ask subcommand', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('ask');
  });

  it('defaults chat to the full-screen OpenTUI runtime', () => {
    const program = buildProgram();
    const chat = program.commands.find((c) => c.name() === 'chat');
    const ui = chat?.options.find((o) => o.long === '--ui');
    expect(ui?.defaultValue).toBe('opentui');
  });
});
