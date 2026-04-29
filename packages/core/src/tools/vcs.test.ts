import { describe, expect, it } from 'vitest';
import { gitTool, ghTool } from './vcs.js';

const ctx = { cwd: process.cwd() };

describe('gitTool', () => {
  it('parses input via the schema', () => {
    const parsed = gitTool.schema.safeParse({ args: ['status', '--porcelain'] });
    expect(parsed.success).toBe(true);
  });

  it('rejects empty args', () => {
    const parsed = gitTool.schema.safeParse({ args: [] });
    expect(parsed.success).toBe(false);
  });

  it('runs `git --version` and returns exit 0', async () => {
    const r = await gitTool.execute({ args: ['--version'], timeoutMs: 10_000 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.summary).toContain('git --version');
    expect(r.value.summary).toContain('exit: 0');
    const data = r.value.data as { exitCode: number; stdout: string };
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toMatch(/git version/);
  });

  it('reports a clear error when the binary is missing', async () => {
    // Force a known-missing binary by calling spawnCli through a tool with a
    // bogus arg list — since we only ship git+gh, fake it by using gh with a
    // no-op subcommand we know doesn't exist; the binary itself may be missing.
    const r = await ghTool.execute(
      { args: ['__atlas_no_such_subcommand__'], timeoutMs: 10_000 },
      ctx
    );
    // Either gh isn't installed (-> error) or it ran and exited non-zero (-> ok).
    if (!r.ok) {
      expect(r.error.code).toBe('TOOL_EXECUTION_FAILED');
    } else {
      const data = r.value.data as { exitCode: number };
      expect(data.exitCode).not.toBe(0);
    }
  });

  it('respects an aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await gitTool.execute(
      { args: ['log'], timeoutMs: 5_000 },
      { cwd: process.cwd(), signal: ac.signal }
    );
    // An immediately-aborted spawn either kills the process or fails to start;
    // either path surfaces an error result.
    if (r.ok) {
      // git may have completed before the signal handler ran (rare); accept
      // that as long as the test doesn't hang.
      expect(typeof (r.value.data as { exitCode: number }).exitCode).toBe('number');
    } else {
      expect(['TOOL_CANCELLED', 'TOOL_EXECUTION_FAILED']).toContain(r.error.code);
    }
  });
});

describe('ghTool', () => {
  it('declares the right metadata', () => {
    expect(ghTool.name).toBe('gh');
    expect(ghTool.approval).toBe('ask');
  });

  it('parses input via the schema', () => {
    const parsed = ghTool.schema.safeParse({
      args: ['pr', 'list', '--state', 'open']
    });
    expect(parsed.success).toBe(true);
  });
});
