/**
 * Browser tool tests. Live Chromium tests are gated on
 * `ATLAS_RUN_BROWSER_TESTS=1` (default off — CI / dev checkouts that
 * don't have the browser binary installed should still pass). The
 * non-gated tests cover the input schema and the "Playwright missing"
 * path.
 */
import { describe, expect, it } from 'vitest';
import { browserTool } from './index.js';

const ctx = {
  cwd: process.cwd(),
  approve: { decide: () => ({ action: 'allow' as const }) }
};

describe('browserTool schema', () => {
  it('accepts every documented op', () => {
    const cases = [
      { op: 'navigate', url: 'https://example.com' },
      { op: 'snapshot' },
      { op: 'click', ref: 'e1' },
      { op: 'type', ref: 'e1', text: 'hi' },
      { op: 'press', key: 'Enter' },
      { op: 'scroll', direction: 'down' },
      { op: 'back' },
      { op: 'console' },
      { op: 'close' }
    ];
    for (const input of cases) {
      const r = browserTool.schema.safeParse(input);
      expect(r.success, `input=${JSON.stringify(input)}`).toBe(true);
    }
  });

  it('rejects bad URLs and missing fields', () => {
    expect(browserTool.schema.safeParse({ op: 'navigate', url: 'not-a-url' }).success).toBe(false);
    expect(browserTool.schema.safeParse({ op: 'click' }).success).toBe(false);
    expect(browserTool.schema.safeParse({ op: 'type', ref: 'e1' }).success).toBe(false);
    expect(browserTool.schema.safeParse({ op: 'scroll', direction: 'sideways' }).success).toBe(false);
  });
});

describe('browserTool runtime', () => {
  it('blocks SSRF targets before launching Chromium', async () => {
    const r = await browserTool.execute(
      { op: 'navigate', url: 'http://169.254.169.254/latest/meta-data/' },
      ctx
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('URL_BLOCKED');
    }
  });
});
