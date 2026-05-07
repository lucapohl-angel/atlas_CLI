import { describe, expect, it } from 'vitest';
import type { Message } from '@atlas/core';
import {
  assistantBoundaryAction,
  isAssistantToolCallMessage
} from './transcript.js';

describe('assistantBoundaryAction', () => {
  it('merges a later assistant round that extends the previous text', () => {
    expect(assistantBoundaryAction('Atlas can help', 'Atlas can help with that.')).toBe('replace');
  });

  it('waits while the next round is still only a prefix of the previous text', () => {
    expect(assistantBoundaryAction('Atlas can help', 'Atlas')).toBe('ignore');
  });

  it('keeps an exact duplicate hidden', () => {
    expect(assistantBoundaryAction('Atlas can help', 'Atlas can help')).toBe('ignore');
  });

  it('keeps distinct multi-round text as a separate assistant entry', () => {
    expect(assistantBoundaryAction('I will inspect the files.', 'I found the issue.')).toBe('append');
  });
});

describe('isAssistantToolCallMessage', () => {
  it('detects assistant tool-call rounds that should not hydrate as chat text', () => {
    const message: Message = {
      role: 'assistant',
      content: 'I will check that.',
      toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{}' }]
    };

    expect(isAssistantToolCallMessage(message)).toBe(true);
  });

  it('does not hide final assistant text', () => {
    expect(isAssistantToolCallMessage({ role: 'assistant', content: 'Done.' })).toBe(false);
  });
});