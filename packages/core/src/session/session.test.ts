import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, SessionStore } from './store.js';

describe('SessionStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-sess-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates, writes, lists, loads, and resumes', async () => {
    const store = new SessionStore(dir);

    const created = await store.create({ cwd: '/x', agent: 'athena' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const rec = created.value;

    rec.messages.push({ role: 'user', content: 'hello' });
    appendAudit(rec, { kind: 'note', summary: 'first turn' });
    const w = await store.write(rec);
    expect(w.ok).toBe(true);

    const list = await store.list();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(1);

    const loaded = await store.load(rec.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.messages[0]?.content).toBe('hello');
    expect(loaded.value.audit[0]?.kind).toBe('note');

    const latest = await store.latest();
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.value?.id).toBe(rec.id);
  });

  it('returns null latest on empty dir', async () => {
    const store = new SessionStore(join(dir, 'sub'));
    const latest = await store.latest();
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.value).toBeNull();
  });
});
