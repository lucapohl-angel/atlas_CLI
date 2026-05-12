import type { ApprovalDecision, ApprovalPolicy, ToolContext } from '@atlas/core/tools/types';
import { formatUnknown, type VsCodeToolHost } from './types.js';
import { InlineClarifyBroker } from '../clarify-broker.js';

export interface InlineApprovalBrokerLike {
  request(tool: string, input: unknown): Promise<ApprovalDecision | null>;
}

export const createVsCodeApprovalPolicy = (
  host: VsCodeToolHost,
  inlineApprovals?: InlineApprovalBrokerLike,
): ApprovalPolicy => ({
  async decide(tool, input) {
    const inlineDecision = await inlineApprovals?.request(tool, input);
    if (inlineDecision) return inlineDecision;

    const choice = await host.window.showInformationMessage(
      `Atlas wants to run ${tool}.`,
      {
        modal: true,
        detail: formatUnknown(input),
      },
      'Allow',
      'Deny',
    );

    return choice === 'Allow'
      ? { action: 'allow' }
      : { action: 'deny', reason: 'denied in VS Code approval prompt' };
  },
});

export const createVsCodeClarifyAsk = (
  broker: InlineClarifyBroker,
): NonNullable<ToolContext['clarifyAsk']> =>
  async (question, choices, signal) => {
    if (signal?.aborted) throw new Error('clarify cancelled');
    return broker.request(question, choices ?? [], true, signal);
  };
