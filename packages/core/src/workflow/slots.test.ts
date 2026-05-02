import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptySlots,
  formatSlotStatus,
  missingRequiredSlots,
  readSlots,
  renderSlotsMarkdown,
  setSlot
} from './slots.js';
import { startTask } from './state.js';
import type { TaskState } from './types.js';

describe('workflow/slots', () => {
  let cwd: string;
  let state: TaskState;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'atlas-slots-'));
    const r = await startTask({ cwd, title: 'demo' });
    if (!r.ok) throw new Error('startTask failed');
    state = r.value;
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('readSlots returns empty when no sidecar exists', async () => {
    const r = await readSlots(state);
    expect(r.ok && r.value).toEqual(emptySlots());
  });

  it('setSlot rejects empty content', async () => {
    const r = await setSlot(state, 'goal', '   ');
    expect(r.ok).toBe(false);
  });

  it('setSlot replaces goal and appends to list slots', async () => {
    await setSlot(state, 'goal', 'Ship a Postgres-backed REST API.');
    await setSlot(state, 'goal', 'Ship a Postgres-backed REST API for receipts.');
    await setSlot(state, 'success', 'GET /receipts returns 200 with seeded data');
    await setSlot(state, 'success', 'pnpm test passes');
    const r = await readSlots(state);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.goal).toBe('Ship a Postgres-backed REST API for receipts.');
      expect(r.value.successCriteria).toHaveLength(2);
    }
  });

  it('missingRequiredSlots lists every slot when sidecar is empty', () => {
    const m = missingRequiredSlots(emptySlots());
    expect(m).toEqual([
      'goal',
      'success',
      'constraints',
      'context',
      'out_of_scope',
      'open_questions'
    ]);
  });

  it('missingRequiredSlots is empty once all six are filled', async () => {
    await setSlot(state, 'goal', 'g');
    await setSlot(state, 'success', 's1');
    await setSlot(state, 'constraints', 'c1');
    await setSlot(state, 'context', 'ctx1');
    await setSlot(state, 'out_of_scope', 'none');
    await setSlot(state, 'open_questions', 'none');
    const r = await readSlots(state);
    if (r.ok) expect(missingRequiredSlots(r.value)).toEqual([]);
  });

  it('formatSlotStatus shows ready when every slot is filled', async () => {
    await setSlot(state, 'goal', 'g');
    await setSlot(state, 'success', 's');
    await setSlot(state, 'constraints', 'c');
    await setSlot(state, 'context', 'ctx');
    await setSlot(state, 'out_of_scope', 'none');
    await setSlot(state, 'open_questions', 'none');
    const r = await readSlots(state);
    if (r.ok) expect(formatSlotStatus(r.value)).toContain('ready to finalize');
  });

  it('renderSlotsMarkdown emits all six sections, with _(none)_ for empties', () => {
    const md = renderSlotsMarkdown({
      ...emptySlots(),
      goal: 'Ship X',
      successCriteria: ['ok']
    });
    expect(md).toContain('## Goal\n\nShip X');
    expect(md).toContain('## Success criteria\n\n- ok');
    expect(md).toContain('## Constraints\n\n_(none)_');
    expect(md).toContain('## Out of scope\n\n_(none)_');
    expect(md).toContain('## Open questions\n\n_(none)_');
  });
});
