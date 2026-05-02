/**
 * `atlas searxng <subcmd>` — manage the local SearXNG container that
 * backs the `web_search` tool. Mirrors the `/searxng` slash command in
 * the TUI so users can drive it from a non-interactive shell.
 */
import {
  searxngStart,
  searxngStatus,
  searxngStop,
  searxngRemove,
  childLogger
} from '@atlas/core';

const log = childLogger('cli:searxng');

export interface RunSearxngOptions {
  readonly sub: string;
}

export interface RunSearxngResult {
  readonly exitCode: number;
}

export const runSearxng = async (opts: RunSearxngOptions): Promise<RunSearxngResult> => {
  const sub = (opts.sub ?? 'status').toLowerCase();

  if (sub === 'status') {
    const s = await searxngStatus();
    if (!s.dockerInstalled) {
      process.stdout.write(
        'searxng: docker is not installed (or daemon not running).\n' +
          'install Docker first, then run `atlas searxng install`.\n'
      );
      return { exitCode: 1 };
    }
    process.stdout.write(
      [
        'searxng status:',
        `  docker:    ok`,
        `  image:     ${s.imagePulled ? 'pulled' : 'not pulled'}`,
        `  container: ${s.containerExists ? (s.running ? 'running' : 'stopped') : 'not created'}`,
        s.url ? `  url:       ${s.url}` : '  url:       (not running)',
        ''
      ].join('\n')
    );
    return { exitCode: s.running ? 0 : 1 };
  }

  if (sub === 'install' || sub === 'start') {
    process.stdout.write('searxng: starting (this can take a minute on first install)…\n');
    const r = await searxngStart({
      progress: (line) => process.stdout.write(line)
    });
    if (!r.ok) {
      log.error({ err: r.error.message }, 'searxng start failed');
      process.stderr.write(`searxng: ${r.error.message}\n`);
      return { exitCode: 1 };
    }
    process.stdout.write(`searxng: running at ${r.value.url ?? '(unknown)'}\n`);
    return { exitCode: 0 };
  }

  if (sub === 'stop') {
    const r = await searxngStop();
    if (!r.ok) {
      process.stderr.write(`searxng: ${r.error.message}\n`);
      return { exitCode: 1 };
    }
    process.stdout.write('searxng: stopped\n');
    return { exitCode: 0 };
  }

  if (sub === 'remove') {
    const r = await searxngRemove();
    if (!r.ok) {
      process.stderr.write(`searxng: ${r.error.message}\n`);
      return { exitCode: 1 };
    }
    process.stdout.write('searxng: container removed\n');
    return { exitCode: 0 };
  }

  process.stderr.write('usage: atlas searxng <status|install|start|stop|remove>\n');
  return { exitCode: 2 };
};
