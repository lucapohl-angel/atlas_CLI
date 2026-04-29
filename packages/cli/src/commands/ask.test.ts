import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Provider, StreamEvent } from '@atlas/core';
import { atlasError } from '@atlas/core';
import { runAsk } from './ask.js';

const collectingStream = (): Writable & { contents: () => string } => {
  const chunks: Buffer[] = [];
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    }
  }) as Writable & { contents: () => string };
  w.contents = () => Buffer.concat(chunks).toString('utf8');
  return w;
};

const fakeProvider = (events: readonly StreamEvent[]): Provider => ({
  name: 'fake',
  async *stream() {
    for (const e of events) yield e;
  }
});

describe('runAsk', () => {
  it('streams deltas to stdout and exits 0', async () => {
    const stdout = collectingStream();
    const stderr = collectingStream();
    const provider = fakeProvider([
      { type: 'delta', text: 'Hello' },
      { type: 'delta', text: ', world' },
      { type: 'done', finishReason: 'stop' }
    ]);

    const r = await runAsk(
      'hi',
      {},
      { stdout, stderr, provider, env: { OPENROUTER_API_KEY: 'x' } }
    );

    expect(r.exitCode).toBe(0);
    expect(stdout.contents()).toBe('Hello, world\n');
    expect(stderr.contents()).toBe('');
  });

  it('rejects an empty prompt with exit code 2', async () => {
    const stderr = collectingStream();
    const r = await runAsk('   ', {}, { stderr, provider: fakeProvider([]) });
    expect(r.exitCode).toBe(2);
    expect(stderr.contents()).toMatch(/empty/);
  });

  it('reports provider errors on stderr with exit code 1', async () => {
    const stdout = collectingStream();
    const stderr = collectingStream();
    const provider = fakeProvider([
      { type: 'error', error: atlasError('PROVIDER_AUTH_FAILED', 'bad key') }
    ]);

    const r = await runAsk('hi', {}, { stdout, stderr, provider });
    expect(r.exitCode).toBe(1);
    expect(stderr.contents()).toContain('[PROVIDER_AUTH_FAILED]');
  });

  it('uses exit code 130 for cancellation', async () => {
    const stderr = collectingStream();
    const provider = fakeProvider([
      { type: 'error', error: atlasError('CANCELLED', 'aborted') }
    ]);

    const r = await runAsk('hi', {}, { stderr, provider });
    expect(r.exitCode).toBe(130);
  });

  it('forwards system prompt and selected model', async () => {
    let captured: { model: string; messages: readonly { role: string; content: string }[] } | null = null;
    const provider: Provider = {
      name: 'capture',
      async *stream(req) {
        captured = { model: req.model, messages: req.messages };
        yield { type: 'done', finishReason: 'stop' };
      }
    };

    await runAsk(
      'do the thing',
      { model: 'openai/gpt-4o-mini', system: 'Be terse.' },
      { provider, stdout: collectingStream(), stderr: collectingStream() }
    );

    expect(captured).not.toBeNull();
    expect(captured!.model).toBe('openai/gpt-4o-mini');
    expect(captured!.messages[0]).toEqual({ role: 'system', content: 'Be terse.' });
    expect(captured!.messages[1]).toEqual({ role: 'user', content: 'do the thing' });
  });
});
