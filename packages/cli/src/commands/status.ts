/**
 * `atlas status` — print detected project state, pending handoffs, and
 * the orchestrator's recommended next agent.
 */
import { detectProjectState, listHandoffs, recommendNext } from '@atlas/core';

export interface StatusOptions {
  readonly cwd?: string;
  readonly stdout?: NodeJS.WritableStream;
  readonly json?: boolean;
  readonly fromAgent?: string;
  readonly lastCommand?: string;
}

export const runStatus = async (opts: StatusOptions = {}): Promise<{ exitCode: number }> => {
  const cwd = opts.cwd ?? process.cwd();
  const stdout = opts.stdout ?? process.stdout;
  const state = await detectProjectState(cwd);

  const handoffsR = await listHandoffs({ cwd });
  const pendingHandoffs = handoffsR.ok ? handoffsR.value : [];

  const recR = await recommendNext({
    cwd,
    ...(opts.fromAgent !== undefined ? { fromAgent: opts.fromAgent } : {}),
    ...(opts.lastCommand !== undefined ? { lastCommand: opts.lastCommand } : {})
  });
  if (!recR.ok) {
    stdout.write(`error: ${recR.error.message}\n`);
    return { exitCode: 1 };
  }
  const rec = recR.value;

  if (opts.json) {
    stdout.write(
      JSON.stringify(
        {
          state,
          pendingHandoffs: pendingHandoffs.map((h) => ({ path: h.path, handoff: h.handoff })),
          recommendation: rec
        },
        null,
        2
      ) + '\n'
    );
  } else {
    stdout.write(`cwd: ${state.cwd}\n`);
    stdout.write(`git: ${state.hasGit ? 'yes' : 'no'}\n`);
    stdout.write(`prd: ${state.hasPRD ? 'docs/prd.md' : 'missing'}\n`);
    stdout.write(`architecture: ${state.hasArchitecture ? 'docs/architecture.md' : 'missing'}\n`);
    stdout.write(`stories: ${state.storyCount}\n`);
    stdout.write(`pending handoffs: ${pendingHandoffs.length}\n`);
    for (const h of pendingHandoffs) {
      const cmd = h.handoff.command ? ` (${h.handoff.command})` : '';
      stdout.write(`  - ${h.handoff.fromAgent} \u2192 ${h.handoff.toAgent}${cmd}\n`);
    }
    stdout.write(`\nrecommended next: ${rec.agent}`);
    if (rec.command) stdout.write(` (${rec.command})`);
    stdout.write(`\n  source: ${rec.source}\n  reason: ${rec.reason}\n`);
  }
  return { exitCode: 0 };
};
