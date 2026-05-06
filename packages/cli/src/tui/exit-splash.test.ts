import { describe, expect, it } from 'vitest';
import { renderAtlasExitSplash, restoreInteractiveTerminal } from './exit-splash.js';

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

  it('restores cursor/input terminal state', () => {
    const writes: string[] = [];
    let rawMode: boolean | null = null;
    let paused = false;

    restoreInteractiveTerminal({
      stdout: {
        isTTY: true,
        write: (chunk: string | Uint8Array): boolean => {
          writes.push(String(chunk));
          return true;
        }
      },
      stdin: {
        isTTY: true,
        setRawMode: (value: boolean) => {
          rawMode = value;
          return {} as NodeJS.ReadStream;
        },
        pause: () => {
          paused = true;
          return {} as NodeJS.ReadStream;
        }
      } as NodeJS.ReadStream
    });

    expect(writes.join('')).toContain('\x1b[?25h');
    expect(writes.join('')).toContain('\x1b[?1004l');
    expect(rawMode).toBe(false);
    expect(paused).toBe(true);
  });
});