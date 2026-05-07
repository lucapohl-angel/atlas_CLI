import type { Message } from '@atlas/core';

export type AssistantBoundaryAction = 'append' | 'replace' | 'ignore';

export const assistantBoundaryAction = (
  previousText: string,
  nextText: string
): AssistantBoundaryAction => {
  if (nextText.length === 0) return 'ignore';
  if (previousText.length === 0) return 'append';
  if (nextText === previousText) return 'ignore';
  if (nextText.startsWith(previousText)) return 'replace';
  if (previousText.startsWith(nextText)) return 'ignore';
  return 'append';
};

export const isAssistantToolCallMessage = (message: Message): boolean =>
  message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0;
