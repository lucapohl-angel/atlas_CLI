import type { ApprovalDecision, ApprovalPolicy, ToolContext } from '@atlas/core/tools/types';
import { formatUnknown, type VsCodeToolHost } from './types.js';

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

export const createVsCodeClarifyAsk = (host: VsCodeToolHost): NonNullable<ToolContext['clarifyAsk']> =>
  async (question, choices, signal) => {
    if (signal?.aborted) return '';
    if (choices && choices.length > 0) {
      const selected = await host.window.showQuickPick(choices, {
        title: 'Atlas needs clarification',
        placeHolder: question,
        ignoreFocusOut: true,
      });
      return selected ?? '';
    }

    return await host.window.showInputBox({
      title: 'Atlas needs clarification',
      prompt: question,
      ignoreFocusOut: true,
    }) ?? '';
  };
