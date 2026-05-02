import { describe, expect, it, vi } from 'vitest';
import { allowAllPolicy } from './registry.js';
import { TodoStore } from './todo-store.js';
import { todoTool } from './todo.js';
import { clarifyTool } from './clarify.js';
import { htmlToText } from './html-to-text.js';

const ctx = (extra: Record<string, unknown> = {}) => ({
  cwd: '/tmp',
  approve: allowAllPolicy,
  ...extra
});

describe('todoTool', () => {
  it('reads empty list when no todos', async () => {
    const r = await todoTool.execute({ merge: false }, ctx({ todoStore: new TodoStore() }) as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.summary).toContain('0 todos');
  });

  it('writes and reads back', async () => {
    const store = new TodoStore();
    const r = await todoTool.execute(
      {
        merge: false,
        todos: [
          { id: '1', content: 'a', status: 'pending' },
          { id: '2', content: 'b', status: 'in_progress' }
        ]
      },
      ctx({ todoStore: store }) as never
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.value.data as { todos: unknown[] }).todos).toHaveLength(2);
      expect(r.value.summary).toContain('2 todos: 1p / 1i');
    }
  });

  it('errors when no TodoStore on ctx', async () => {
    const r = await todoTool.execute({ merge: false }, ctx() as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('TodoStore');
  });
});

describe('clarifyTool', () => {
  it('errors when no clarifyAsk callback', async () => {
    const r = await clarifyTool.execute({ question: 'hi?' }, ctx() as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('clarifyAsk');
  });

  it('passes question and choices to callback', async () => {
    const cb = vi.fn().mockResolvedValue('Tavily');
    const r = await clarifyTool.execute(
      { question: 'pick a search backend', choices: ['Tavily', 'Exa'] },
      ctx({ clarifyAsk: cb }) as never
    );
    expect(cb).toHaveBeenCalledWith('pick a search backend', ['Tavily', 'Exa'], undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary).toBe('user: Tavily');
      expect((r.value.data as { answer: string }).answer).toBe('Tavily');
    }
  });

  it('treats empty choices array as open-ended', async () => {
    const cb = vi.fn().mockResolvedValue('blue');
    await clarifyTool.execute(
      { question: 'color?', choices: [] },
      ctx({ clarifyAsk: cb }) as never
    );
    expect(cb).toHaveBeenCalledWith('color?', undefined, undefined);
  });

  it('captures callback error', async () => {
    const cb = vi.fn().mockRejectedValue(new Error('user closed'));
    const r = await clarifyTool.execute(
      { question: 'q?' },
      ctx({ clarifyAsk: cb }) as never
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('user closed');
  });
});

describe('htmlToText', () => {
  it('extracts title and body', () => {
    const html =
      '<html><head><title>Hello</title><style>x{}</style></head><body>' +
      '<h1>Hi</h1><p>line one</p><p>line two</p><script>evil()</script></body></html>';
    const r = htmlToText(html);
    expect(r.title).toBe('Hello');
    expect(r.text).toContain('Hi');
    expect(r.text).toContain('line one');
    expect(r.text).toContain('line two');
    expect(r.text).not.toContain('evil');
    expect(r.text).not.toContain('x{}');
  });

  it('decodes common entities', () => {
    const r = htmlToText('<p>Tom &amp; Jerry &mdash; &copy;2026</p>');
    expect(r.text).toContain('Tom & Jerry — ©2026');
  });

  it('truncates beyond maxChars', () => {
    const big = '<p>' + 'a'.repeat(100) + '</p>';
    const r = htmlToText(big, { maxChars: 50 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(50);
  });

  it('handles no title gracefully', () => {
    const r = htmlToText('<p>just text</p>');
    expect(r.title).toBe('');
    expect(r.text).toContain('just text');
  });
});
