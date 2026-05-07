#!/usr/bin/env node
/**
 * Atlas CLI entry point.
 *
 * For now this is a thin stub — Phase 1 wires it to the provider engine
 * for single-turn questions, Phase 2 adds the interactive REPL.
 */
// Default subcommand is the interactive TUI. When that's the case we
// silence pino so its stderr output doesn't corrupt the alt-screen.
// Detect early — before any @atlas/core import — so the logger picks it
// up at construction time. Errors are still surfaced inside the TUI.
const argv = process.argv.slice(2);
const firstNonFlag = argv.find((a) => !a.startsWith('-'));
const isTuiInvocation =
  (firstNonFlag === undefined || firstNonFlag === 'chat') && !argv.includes('--no-tui');
if (isTuiInvocation && process.env['ATLAS_LOG_LEVEL'] === undefined) {
  process.env['ATLAS_TUI'] = '1';
}

const { run } = await import('../app.js');

run(process.argv).catch((err: unknown) => {
  // Top-level error boundary: log and exit non-zero so shells/CI see the failure.
  // Detailed diagnostics already went through the structured logger. Set
  // ATLAS_DEBUG=1 to also print the stack — invaluable when an early
  // ReferenceError swallows itself with just "X is not defined".
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`atlas: fatal error: ${message}\n`);
  if (process.env['ATLAS_DEBUG'] === '1' && err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
