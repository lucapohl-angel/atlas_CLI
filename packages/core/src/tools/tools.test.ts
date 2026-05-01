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

describe('composeToolDescription', () => {
  it('builds a richer description from optional fields', async () => {
    const { composeToolDescription, readFileTool, writeFileTool, terminalTool, gitTool, ghTool } =
      await import('./index.js');
    for (const tool of [readFileTool, writeFileTool, terminalTool, gitTool, ghTool]) {
      const composed = composeToolDescription(tool);
      expect(composed).toContain(tool.description);
      expect(composed).toContain('When to use:');
      expect(composed).toContain('Output contract:');
      expect(composed).toContain('Examples:');
      expect(composed.length).toBeGreaterThanOrEqual(200);
    }
  });

  it('omits sections when fields are absent', async () => {
    const { composeToolDescription } = await import('./index.js');
    const z = await import('zod');
    const minimal = {
      name: 'min',
      description: 'a minimal tool',
      approval: 'auto' as const,
      schema: z.z.object({}),
      execute: async () => ({ ok: false }) as never
    };
    const out = composeToolDescription(minimal);
    expect(out).toBe('a minimal tool');
  });
});

describe('story tools', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-story-tools-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('story_create scaffolds a file under cwd/docs/stories', async () => {
    const r = await invokeTool(
      builtinToolRegistry(),
      'story_create',
      { id: 'login', title: 'Login flow' },
      { cwd: dir, approve: allowAllPolicy }
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data as { path: string };
    const onDisk = await readFile(data.path, 'utf8');
    expect(onDisk).toContain('## Goals');
    expect(onDisk).toContain('## Tasks');
    expect(onDisk).toContain('id: login');
  });

  it('story_update hard-fails on forbiddenSections', async () => {
    const c = await invokeTool(
      builtinToolRegistry(),
      'story_create',
      { id: 's', title: 'S' },
      { cwd: dir, approve: allowAllPolicy }
    );
    if (!c.ok) throw new Error('setup failed');
    const path = (c.value.data as { path: string }).path;

    const r = await invokeTool(
      builtinToolRegistry(),
      'story_update',
      { path, sectionTitle: 'Goals', content: 'x' },
      {
        cwd: dir,
        approve: allowAllPolicy,
        callingAgent: {
          name: 'hercules',
          authorizedSections: ['Tasks'],
          forbiddenSections: ['Goals']
        }
      }
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('STORY_SECTION_FORBIDDEN');
    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).not.toContain('\nx\n');
  });

  it('story_update warn+writes on unauthorized-but-not-forbidden', async () => {
    const c = await invokeTool(
      builtinToolRegistry(),
      'story_create',
      { id: 's', title: 'S' },
      { cwd: dir, approve: allowAllPolicy }
    );
    if (!c.ok) throw new Error('setup failed');
    const path = (c.value.data as { path: string }).path;

    const r = await invokeTool(
      builtinToolRegistry(),
      'story_update',
      { path, sectionTitle: 'Test Strategy', content: 'covered by integration' },
      {
        cwd: dir,
        approve: allowAllPolicy,
        callingAgent: {
          name: 'hercules',
          authorizedSections: ['Tasks'],
          forbiddenSections: ['Goals']
        }
      }
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.summary).toContain('warning:');
    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).toContain('covered by integration');
    expect(onDisk).toContain('soft-boundary cross');
  });

  it('handoff_emit + handoff_consume round-trip via toAgent', async () => {
    const e = await invokeTool(
      builtinToolRegistry(),
      'handoff_emit',
      { fromAgent: 'athena', toAgent: 'prometheus', command: 'write-architecture' },
      { cwd: dir, approve: allowAllPolicy }
    );
    expect(e.ok).toBe(true);

    const c = await invokeTool(
      builtinToolRegistry(),
      'handoff_consume',
      { toAgent: 'prometheus' },
      { cwd: dir, approve: allowAllPolicy }
    );
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.value.summary).toContain('athena');
    expect(c.value.summary).toContain('prometheus');

    // Second consume should return HANDOFF_NOT_FOUND.
    const c2 = await invokeTool(
      builtinToolRegistry(),
      'handoff_consume',
      { toAgent: 'prometheus' },
      { cwd: dir, approve: allowAllPolicy }
    );
    expect(c2.ok).toBe(false);
    if (!c2.ok) expect(c2.error.code).toBe('HANDOFF_NOT_FOUND');
  });
});
