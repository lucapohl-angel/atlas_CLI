import { describe, expect, it } from 'vitest';
import { TodoStore, summarize } from './todo-store.js';

describe('TodoStore', () => {
  it('starts empty', () => {
    const s = new TodoStore();
    expect(s.read()).toEqual([]);
    expect(s.hasItems()).toBe(false);
    expect(s.formatForInjection()).toBeNull();
  });

  it('write replaces by default', () => {
    const s = new TodoStore();
    s.write([{ id: '1', content: 'a', status: 'pending' }], false);
    s.write([{ id: '2', content: 'b', status: 'pending' }], false);
    const items = s.read();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('2');
  });

  it('merge updates existing by id and appends new', () => {
    const s = new TodoStore();
    s.write(
      [
        { id: '1', content: 'a', status: 'pending' },
        { id: '2', content: 'b', status: 'pending' }
      ],
      false
    );
    s.write(
      [
        { id: '1', content: 'a', status: 'completed' },
        { id: '3', content: 'c', status: 'pending' }
      ],
      true
    );
    const items = s.read();
    expect(items).toHaveLength(3);
    expect(items[0]?.status).toBe('completed');
    expect(items[2]?.id).toBe('3');
  });

  it('coerces invalid status to pending', () => {
    const s = new TodoStore();
    s.write([{ id: '1', content: 'a', status: 'banana' }], false);
    expect(s.read()[0]?.status).toBe('pending');
  });

  it('formatForInjection skips completed/cancelled', () => {
    const s = new TodoStore();
    s.write(
      [
        { id: '1', content: 'a', status: 'completed' },
        { id: '2', content: 'b', status: 'in_progress' }
      ],
      false
    );
    const out = s.formatForInjection() ?? '';
    expect(out).toContain('b');
    expect(out).not.toContain('1. a');
  });

  it('formatForInjection returns null when only completed remain', () => {
    const s = new TodoStore();
    s.write([{ id: '1', content: 'a', status: 'completed' }], false);
    expect(s.formatForInjection()).toBeNull();
  });

  it('dedupes ids on write, keeping last', () => {
    const s = new TodoStore();
    s.write(
      [
        { id: '1', content: 'first', status: 'pending' },
        { id: '1', content: 'second', status: 'pending' }
      ],
      false
    );
    expect(s.read()).toHaveLength(1);
    expect(s.read()[0]?.content).toBe('second');
  });

  it('summarize counts by status', () => {
    const items = [
      { id: '1', content: 'a', status: 'pending' as const },
      { id: '2', content: 'b', status: 'in_progress' as const },
      { id: '3', content: 'c', status: 'completed' as const },
      { id: '4', content: 'd', status: 'cancelled' as const }
    ];
    expect(summarize(items)).toEqual({
      total: 4,
      pending: 1,
      in_progress: 1,
      completed: 1,
      cancelled: 1
    });
  });
});
