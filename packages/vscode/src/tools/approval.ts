import { allowAllPolicy, denyAllPolicy } from '@atlas/core/tools/registry';
import type { ApprovalDecision, ApprovalPolicy, ToolContext } from '@atlas/core/tools/types';
import { formatUnknown, type VsCodeToolHost } from './types.js';
import { InlineClarifyBroker } from '../clarify-broker.js';
import { ShipConflictBroker } from '../ship-conflict-broker.js';

export interface InlineApprovalBrokerLike {
  request(tool: string, input: unknown): Promise<ApprovalDecision | null>;
}

export const createVsCodeApprovalPolicy = (
  host: VsCodeToolHost,
  inlineApprovals: InlineApprovalBrokerLike | undefined,
  mode: 'plan' | 'build' | 'autopilot',
): ApprovalPolicy => {
  if (mode === 'plan') return denyAllPolicy;
  if (mode === 'autopilot') return allowAllPolicy;
  return {
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
  };
};

export const createVsCodeClarifyAsk = (
  broker: InlineClarifyBroker,
): NonNullable<ToolContext['clarifyAsk']> =>
  async (question, choices, signal) => {
    if (signal?.aborted) throw new Error('clarify cancelled');
    return broker.request(question, choices ?? [], true, signal);
  };

export const createVsCodeShipResolveAsk = (
  broker: ShipConflictBroker,
): NonNullable<ToolContext['shipResolveAsk']> =>
  async (req) => {
    return broker.request(req, req.signal);
  };
