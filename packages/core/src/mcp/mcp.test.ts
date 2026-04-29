import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpClient } from './client.js';

/**
 * We test the MCP client by spawning a tiny Node "server" that
 * speaks the JSON-RPC line protocol. That avoids any external dep
 * and verifies framing + initialize + tools/list + tools/call.
 */
const SERVER_SCRIPT = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {} } });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo', description: 'echo input', inputSchema: { type: 'object' } }
    ]}});
    return;
  }
  if (msg.method === 'tools/call') {
    const args = msg.params && msg.params.arguments;
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + (args?.text ?? '') }] }});
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' }});
});
`;

describe('McpClient (stdio)', () => {
  let dir: string;
  let serverPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-mcp-'));
    serverPath = join(dir, 'server.cjs');
    await writeFile(serverPath, SERVER_SCRIPT, 'utf8');
    await chmod(serverPath, 0o755);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('initializes, lists tools, and calls a tool', async () => {
    const client = new McpClient({
      name: 'echo',
      command: process.execPath,
      args: [serverPath]
    });
    try {
      const startR = await client.start();
      expect(startR.ok).toBe(true);

      const tools = await client.listTools();
      expect(tools.ok).toBe(true);
      if (tools.ok) {
        expect(tools.value).toHaveLength(1);
        expect(tools.value[0]?.name).toBe('echo');
      }

      const call = await client.callTool('echo', { text: 'hi' });
      expect(call.ok).toBe(true);
      if (call.ok) {
        expect(call.value.text).toBe('echo:hi');
        expect(call.value.isError).toBe(false);
      }
    } finally {
      client.stop();
    }
  });
});
