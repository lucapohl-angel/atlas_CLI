import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allowAllPolicy,
  builtinToolRegistry,
  denyAllPolicy,
  invokeTool
} from './index.js';

describe('tool pipeline', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-tools-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects unknown tools', async () => {
    const r = await invokeTool(builtinToolRegistry(), 'nope', {}, {
      cwd: dir,
      approve: allowAllPolicy
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TOOL_NOT_FOUND');
  });

  it('rejects schema-invalid input', async () => {
    const r = await invokeTool(builtinToolRegistry(), 'read_file', { path: 123 }, {
      cwd: dir,
      approve: allowAllPolicy
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TOOL_INPUT_INVALID');
  });

  it('read_file returns the file contents', async () => {
    const path = 'hello.txt';
    const fs = await import('node:fs/promises');
    await fs.writeFile(join(dir, path), 'hello world', 'utf8');

    const r = await invokeTool(builtinToolRegistry(), 'read_file', { path }, {
      cwd: dir,
      approve: allowAllPolicy
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toContain('hello world');
      const data = r.value.data as { content: string };
      expect(data.content).toBe('hello world');
    }
  });

  it('read_file refuses paths that escape cwd', async () => {
    const r = await invokeTool(builtinToolRegistry(), 'read_file', { path: '../etc/passwd' }, {
      cwd: dir,
      approve: allowAllPolicy
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TOOL_EXECUTION_FAILED');
  });

  it('write_file is denied by deny-all policy', async () => {
    const r = await invokeTool(
      builtinToolRegistry(),
      'write_file',
      { path: 'x.txt', content: 'no' },
      { cwd: dir, approve: denyAllPolicy }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TOOL_DENIED_BY_USER');
  });

  it('write_file persists content when approved', async () => {
    const r = await invokeTool(
      builtinToolRegistry(),
      'write_file',
      { path: 'sub/out.txt', content: 'persisted' },
      { cwd: dir, approve: allowAllPolicy }
    );
    expect(r.ok).toBe(true);
    const written = await readFile(join(dir, 'sub/out.txt'), 'utf8');
    expect(written).toBe('persisted');
  });

  it('terminal captures stdout and exit code', async () => {
    const r = await invokeTool(
      builtinToolRegistry(),
      'terminal',
      { command: "printf 'hi'" },
      { cwd: dir, approve: allowAllPolicy }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.value.data as { exitCode: number; stdout: string };
      expect(data.exitCode).toBe(0);
      expect(data.stdout).toBe('hi');
    }
  });

  it('terminal honors timeout', async () => {
    const r = await invokeTool(
      builtinToolRegistry(),
      'terminal',
      { command: 'sleep 5', timeoutMs: 100 },
      { cwd: dir, approve: allowAllPolicy }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('timeout');
  });

  it('terminal honors abort signal', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r = await invokeTool(
      builtinToolRegistry(),
      'terminal',
      { command: 'sleep 5' },
      { cwd: dir, approve: allowAllPolicy, signal: ac.signal }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TOOL_CANCELLED');
  });
});
