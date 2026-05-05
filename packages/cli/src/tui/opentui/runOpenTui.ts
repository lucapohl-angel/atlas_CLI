/**
 * OpenTUI runtime entry — Phase 1.
 *
 * Builds the same `props` object the Ink TUI uses, then mounts the
 * OpenTUI React tree via @opentui/react's `createRoot`. We don't
 * import @opentui/* at the top of `runTui.ts` so Node-only callers
 * (the `--no-tui` REPL, tests) never pay the FFI-load cost — the
 * dynamic import here only fires when the user explicitly opts in
 * via `--ui=opentui`.
 *
 * Runtime: Bun-only. Loading @opentui/core under Node throws
 * `ERR_UNKNOWN_BUILTIN_MODULE: node:ffi`. We surface that as a clear
 * "this UI requires Bun" error rather than a stack trace.
 */
import React from 'react';
import type { OpenTuiAppProps } from './OpenTuiApp.js';

export interface RunOpenTuiResult {
  readonly exitCode: number;
}

export const runOpenTui = async (
  props: OpenTuiAppProps
): Promise<RunOpenTuiResult> => {
  let core: typeof import('@opentui/core');
  let reactBinding: typeof import('@opentui/react');
  let appModule: typeof import('./OpenTuiApp.js');
  try {
    [core, reactBinding, appModule] = await Promise.all([
      import('@opentui/core'),
      import('@opentui/react'),
      import('./OpenTuiApp.js')
    ]);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (/node:ffi|node-ffi|UNKNOWN_BUILTIN_MODULE/i.test(msg)) {
      process.stderr.write(
        'atlas: --ui=opentui requires the Bun runtime. Reinstall via the\n' +
          '       precompiled binary (`npm i -g atlas-os`) or run with\n' +
          '       `bun run`. Falling back to the Ink UI is available via\n' +
          '       omitting --ui or passing --ui=ink.\n'
      );
      return { exitCode: 1 };
    }
    process.stderr.write(`atlas: failed to load OpenTUI: ${msg}\n`);
    return { exitCode: 1 };
  }

  const { createCliRenderer } = core;
  const { createRoot } = reactBinding;
  const { OpenTuiApp } = appModule;

  // Atlas navy default-bg via OSC 11 (same trick as the Ink path).
  // Always paint the terminal default + always enter alt-screen so
  // the renderer's backing buffer fully covers the parent terminal —
  // otherwise cells the renderer never touches (e.g. between frames,
  // or before the first commit) leak through the user's previous
  // terminal contents and read as "transparent middle."
  const ATLAS_BG = '#0b1220';
  const paintBg = !process.env['ATLAS_NO_PAINT_BG'];
  if (paintBg) {
    // Enter the alternate screen buffer manually before the renderer
    // initialises. Some TTYs ignore the renderer's own screenMode
    // request when stdin/stdout aren't quite what it expects.
    process.stdout.write('\x1b[?1049h');
    // OSC 11 sets the default background color (Atlas navy).
    process.stdout.write(`\x1b]11;${ATLAS_BG}\x07`);
    // Clear screen + scrollback so the alt-screen we're about to
    // enter starts on a uniformly-painted canvas.
    process.stdout.write('\x1b[2J\x1b[H');
  }
  const restoreBg = (): void => {
    if (paintBg) {
      process.stdout.write('\x1b]111\x07');
      process.stdout.write('\x1b[?1049l');
    }
  };
  process.on('exit', restoreBg);

  let renderer: Awaited<ReturnType<typeof createCliRenderer>>;
  try {
    renderer = await createCliRenderer({
      // We handle Ctrl-C ourselves (active stream cancel first, then quit).
      exitOnCtrlC: false,
      // Disable the Kitty keyboard protocol. When enabled (the
      // default), the terminal emulator forwards EVERY modified
      // key (including Ctrl-Shift-C / Ctrl-Shift-V) to the app
      // instead of intercepting them — which means the user
      // loses native terminal copy/paste. With this off we get
      // standard escape sequences and the terminal keeps its
      // normal copy-on-Ctrl-Shift-C / paste-on-Ctrl-Shift-V
      // bindings. Trade-off: Shift-Enter (and other modified
      // keys) only fire in terminals that send CSI-u or
      // modifyOtherKeys natively — which is fine because we
      // already advertise Alt-Enter / Ctrl-J as the universal
      // newline fallbacks.
      useKittyKeyboard: null,
      screenMode: 'alternate-screen' as const,
      backgroundColor: ATLAS_BG
    });
  } catch (err) {
    process.off('exit', restoreBg);
    restoreBg();
    process.stderr.write(
      `atlas: failed to start OpenTUI renderer: ${(err as Error).message}\n`
    );
    return { exitCode: 1 };
  }

  // Belt-and-suspenders: explicitly tell the renderer to clear to navy
  // so cells the React tree doesn't claim still read as Atlas-branded
  // rather than terminal-default.
  try {
    renderer.setBackgroundColor?.(ATLAS_BG);
  } catch {
    /* noop — older builds don't expose this method */
  }

  // Resolve the exit promise on user-requested quit (Ctrl-C / Ctrl-D twice).
  let resolveExit!: () => void;
  const exited = new Promise<void>((res) => {
    resolveExit = res;
  });
  const onExit = (): void => {
    try {
      renderer.destroy?.();
    } catch {
      /* noop */
    }
    resolveExit();
  };

  const appProps: OpenTuiAppProps = { ...props, onExit };
  createRoot(renderer).render(React.createElement(OpenTuiApp, appProps));

  try {
    await exited;
  } finally {
    process.off('exit', restoreBg);
    restoreBg();
  }
  return { exitCode: 0 };
};
