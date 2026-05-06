/**
 * In-memory task list backing the `todo` tool. One instance per
 * session, lives on the host (TUI / CLI runner) and is passed into
 * `ToolContext`:
 *   - list order is priority
 *   - items have id, content, status
 *   - `write` either replaces (default) or merges by id
 *   - `formatForInjection` renders only the still-active items so the
 *     model isn't tempted to redo completed work after a compaction.
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
}

const STATUSES: readonly TodoStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'cancelled'
];
const isStatus = (s: string): s is TodoStatus =>
  (STATUSES as readonly string[]).includes(s);

export interface TodoInput {
  readonly id?: string;
  readonly content?: string;
  readonly status?: string;
}

const validate = (raw: TodoInput): TodoItem => {
  const id = (raw.id ?? '').trim() || '?';
  const content = (raw.content ?? '').trim() || '(no description)';
  const s = (raw.status ?? 'pending').trim().toLowerCase();
  const status: TodoStatus = isStatus(s) ? s : 'pending';
  return { id, content, status };
};

const dedupeById = (todos: readonly TodoInput[]): TodoInput[] => {
  // Keep last occurrence of each id, preserving insertion position.
  const lastIdx = new Map<string, number>();
  todos.forEach((t, i) => {
    const id = (t.id ?? '').trim() || '?';
    lastIdx.set(id, i);
  });
  const keepIdx = new Set(lastIdx.values());
  return todos.filter((_, i) => keepIdx.has(i));
};

export class TodoStore {
  private items: TodoItem[] = [];

  read(): readonly TodoItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  write(todos: readonly TodoInput[], merge: boolean): readonly TodoItem[] {
    const deduped = dedupeById(todos);
    if (!merge) {
      this.items = deduped.map(validate);
      return this.read();
    }
    const byId = new Map(this.items.map((i) => [i.id, i] as const));
    for (const t of deduped) {
      const id = (t.id ?? '').trim();
      if (!id) continue;
      const existing = byId.get(id);
      if (existing) {
        const next: TodoItem = {
          ...existing,
          ...(typeof t.content === 'string' && t.content.trim()
            ? { content: t.content.trim() }
            : {}),
          ...(typeof t.status === 'string' && isStatus(t.status.trim().toLowerCase())
            ? { status: t.status.trim().toLowerCase() as TodoStatus }
            : {})
        };
        byId.set(id, next);
      } else {
        const v = validate(t);
        byId.set(v.id, v);
        this.items.push(v);
      }
    }
    this.items = this.items.map((i) => byId.get(i.id) ?? i);
    return this.read();
  }

  hasItems(): boolean {
    return this.items.length > 0;
  }

  /**
   * Render the active part of the list for re-injection into the
   * conversation after auto-compaction. Completed and cancelled items
   * are intentionally dropped so the model doesn't try to redo them.
   * Returns null when there is nothing actionable left.
   */
  formatForInjection(): string | null {
    if (this.items.length === 0) return null;
    const active = this.items.filter(
      (i) => i.status === 'pending' || i.status === 'in_progress'
    );
    if (active.length === 0) return null;
    const marker: Record<TodoStatus, string> = {
      completed: '[x]',
      in_progress: '[>]',
      pending: '[ ]',
      cancelled: '[~]'
    };
    const lines = ['[Your active task list was preserved across context compression]'];
    for (const i of active) {
      lines.push(`- ${marker[i.status]} ${i.id}. ${i.content} (${i.status})`);
    }
    return lines.join('\n');
  }
}

export interface TodoSummary {
  readonly total: number;
  readonly pending: number;
  readonly in_progress: number;
  readonly completed: number;
  readonly cancelled: number;
}

export const summarize = (items: readonly TodoItem[]): TodoSummary => ({
  total: items.length,
  pending: items.filter((i) => i.status === 'pending').length,
  in_progress: items.filter((i) => i.status === 'in_progress').length,
  completed: items.filter((i) => i.status === 'completed').length,
  cancelled: items.filter((i) => i.status === 'cancelled').length
});
