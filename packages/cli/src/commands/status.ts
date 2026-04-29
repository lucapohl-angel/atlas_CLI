/**
 * `atlas status` — print detected project state and recommended agent.
 */
import { detectProjectState, recommendAgent } from '@atlas/core';

export interface StatusOptions {
  readonly cwd?: string;
  readonly stdout?: NodeJS.WritableStream;
  readonly json?: boolean;
}

export const runStatus = async (opts: StatusOptions = {}): Promise<{ exitCode: number }> => {
  const cwd = opts.cwd ?? process.cwd();
  const stdout = opts.stdout ?? process.stdout;
  const state = await detectProjectState(cwd);
  const rec = recommendAgent(state);
  if (opts.json) {
    stdout.write(JSON.stringify({ state, recommendation: rec }, null, 2) + '\n');
  } else {
    stdout.write(`cwd: ${state.cwd}\n`);
    stdout.write(`git: ${state.hasGit ? 'yes' : 'no'}\n`);
    stdout.write(`prd: ${state.hasPRD ? 'docs/prd.md' : 'missing'}\n`);
    stdout.write(`architecture: ${state.hasArchitecture ? 'docs/architecture.md' : 'missing'}\n`);
    stdout.write(`stories: ${state.storyCount}\n`);
    stdout.write(`\nrecommended agent: ${rec.agent}\n  reason: ${rec.reason}\n`);
  }
  return { exitCode: 0 };
};
