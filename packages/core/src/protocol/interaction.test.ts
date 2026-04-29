import { describe, expect, it } from 'vitest';
import {
  parseInteractionBlock,
  renderInteractionInstructions,
  tryExtractInteraction
} from './interaction.js';

describe('interaction protocol', () => {
  it('parses a well-formed block', () => {
    const req = parseInteractionBlock(
      ['prompt: pick a database', '- SQLite', '- PostgreSQL', 'freeform: false'].join('\n')
    );
    expect(req).not.toBeNull();
    expect(req?.prompt).toBe('pick a database');
    expect(req?.options.map((o) => o.label)).toEqual(['SQLite', 'PostgreSQL']);
    expect(req?.allowFreeform).toBe(false);
  });

  it('defaults allowFreeform to true', () => {
    const req = parseInteractionBlock('prompt: anything?');
    expect(req?.allowFreeform).toBe(true);
    expect(req?.options).toEqual([]);
  });

  it('returns null when prompt is missing', () => {
    expect(parseInteractionBlock('- only options here')).toBeNull();
  });

  it('extracts an embedded block from surrounding markdown', () => {
    const text = [
      'Sure, before I draft anything:',
      '<atlas:question>',
      'prompt: which framework?',
      '- React',
      '- Svelte',
      '</atlas:question>',
      'Then I will continue.'
    ].join('\n');
    const out = tryExtractInteraction(text);
    expect(out).not.toBeNull();
    expect(out?.request.prompt).toBe('which framework?');
    expect(out?.remaining).toContain('Sure, before I draft anything:');
    expect(out?.remaining).toContain('Then I will continue.');
    expect(out?.remaining).not.toContain('<atlas:question>');
  });

  it('returns null while the block is still streaming', () => {
    const partial = 'Thinking…\n<atlas:question>\nprompt: not done yet';
    expect(tryExtractInteraction(partial)).toBeNull();
  });

  it('renders instructions including the no-cap clause', () => {
    const text = renderInteractionInstructions();
    expect(text).toMatch(/<atlas:question>/);
    expect(text).toMatch(/no cap/i);
  });
});
