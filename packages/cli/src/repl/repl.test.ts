import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Provider, StreamEvent } from '@atlas/core';
import { runRepl } from './repl.js';

const fromLines = (lines: readonly string[]): Readable => Readable.from(lines.map((l) => l + '\n'));

const sink = (): Writable & { text: () => string } => {
  const chunks: Buffer[] = [];
  const w = new Writable({
    write(c, _e, cb) {
      chunks.push(Buffer.from(c));
      cb();
    }
  }) as Writable & { text: () => string };
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
};

const echoProvider = (events: (msgCount: number) => readonly StreamEvent[]): Provider => ({
  name: 'echo',
  async *stream(req) {
    for (const e of events(req.messages.length)) yield e;
  }
});

describe('REPL', () => {
  it('round-trips a single user message and persists assistant reply', async () => {
    const stdout = sink();
    const stderr = sink();
    const provider = echoProvider(() => [
      { type: 'delta', text: 'hi back' },
      { type: 'done', finishReason: 'stop' }
    ]);

    const r = await runRepl({
      stdin: fromLines(['hello', '/exit']),
      stdout,
      stderr,
      provider,
      quiet: true
    });

    expect(r.exitCode).toBe(0);
    expect(r.history).toHaveLength(2);
    expect(r.history[1]).toEqual({ role: 'assistant', content: 'hi back' });
    expect(stdout.text()).toContain('hi back');
  });

  it('/clear empties history', async () => {
    const provider = echoProvider(() => [
      { type: 'delta', text: 'ok' },
      { type: 'done', finishReason: 'stop' }
    ]);
    const r = await runRepl({
      stdin: fromLines(['hi', '/clear', '/exit']),
      stdout: sink(),
      stderr: sink(),
      provider,
      quiet: true
    });
    expect(r.history).toHaveLength(0);
  });

  it('/model switches the active model on the next request', async () => {
    let observed = '';
    const provider: Provider = {
      name: 'capture',
      async *stream(req) {
        observed = req.model;
        yield { type: 'delta', text: 'x' };
        yield { type: 'done', finishReason: 'stop' };
      }
    };

    await runRepl({
      stdin: fromLines(['/model openai/gpt-4o-mini', 'hi', '/exit']),
      stdout: sink(),
      stderr: sink(),
      provider,
      quiet: true
    });

    expect(observed).toBe('openai/gpt-4o-mini');
  });

  it('drops the user turn after a cancelled stream', async () => {
    const provider: Provider = {
      name: 'cancel',
      async *stream() {
        yield { type: 'delta', text: 'partial' };
        yield {
          type: 'error',
          error: { code: 'CANCELLED', message: 'aborted', recoverable: true, context: {} } as never
        };
      }
    };
    const r = await runRepl({
      stdin: fromLines(['will be cancelled', '/exit']),
      stdout: sink(),
      stderr: sink(),
      provider,
      quiet: true
    });
    expect(r.history).toHaveLength(0);
  });

  it('reports unknown slash commands without exiting', async () => {
    const stderr = sink();
    const provider = echoProvider(() => [{ type: 'done', finishReason: 'stop' }]);
    const r = await runRepl({
      stdin: fromLines(['/wat', '/exit']),
      stdout: sink(),
      stderr,
      provider,
      quiet: true
    });
    expect(r.exitCode).toBe(0);
    expect(stderr.text()).toContain('unknown command');
  });
});
