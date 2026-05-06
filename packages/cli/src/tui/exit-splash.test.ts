import { describe, expect, it } from 'vitest';
import { renderAtlasExitSplash } from './exit-splash.js';

describe('renderAtlasExitSplash', () => {
  it('renders a plain Atlas OS wordmark', () => {
    const output = renderAtlasExitSplash(false);

    expect(output).toContain('ATLAS OS');
    expect(output).toContain('Autonomous Teams');
    expect(output).not.toContain('\x1b[');
  });

  it('adds ANSI styling when color is enabled', () => {
    const output = renderAtlasExitSplash(true);

    expect(output).toContain('\x1b[');
    expect(output).toContain('ATLAS OS');
  });
});