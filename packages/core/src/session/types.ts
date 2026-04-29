/**
 * Sessions persist conversation transcripts (and a small audit log)
 * to `~/.atlas/sessions/<id>.json`. They let users `atlas resume` a
 * prior chat or replay decisions later.
 */
import type { Message } from '../providers/types.js';

export interface AuditEntry {
  readonly ts: string;
  readonly kind: 'tool' | 'hook' | 'compact' | 'agent' | 'note';
  readonly summary: string;
  readonly data?: Record<string, unknown>;
}

export interface SessionRecord {
  readonly id: string;
  readonly createdAt: string;
  updatedAt: string;
  agent?: string;
  model?: string;
  cwd: string;
  messages: Message[];
  audit: AuditEntry[];
}
