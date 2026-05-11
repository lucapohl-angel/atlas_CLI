import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ApprovalDecision } from '@atlas/core/tools/types';
import { type BridgeResponse } from './bridge.js';
import { formatUnknown } from './tools/types.js';

export interface InlineApprovalRequest {
  readonly id: string;
  readonly tool: string;
  readonly preview: string;
  readonly createdAt: string;
}

interface PendingApproval {
  readonly request: InlineApprovalRequest;
  readonly resolve: (decision: ApprovalDecision) => void;
}

export class InlineApprovalBroker {
  private webview: vscode.Webview | null = null;
  private activeRequestId: string | null = null;
  private readonly pending = new Map<string, PendingApproval>();

  public constructor(private readonly output: vscode.OutputChannel) {}

  public attach(webview: vscode.Webview): void {
    this.webview = webview;
  }

  public detach(webview: vscode.Webview): void {
    if (this.webview === webview) this.webview = null;
  }

  public setActiveRequestId(requestId: string | null): void {
    this.activeRequestId = requestId;
  }

  public hasWebview(): boolean {
    return this.webview !== null;
  }

  public async request(tool: string, input: unknown): Promise<ApprovalDecision | null> {
    if (!this.webview) return null;
    const approval: InlineApprovalRequest = {
      id: createApprovalId(),
      tool,
      preview: sanitizeApprovalPreview(input),
      createdAt: new Date().toISOString(),
    };
    const decision = new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(approval.id, { request: approval, resolve });
    });
    await this.post({
      requestId: this.activeRequestId ?? approval.id,
      kind: 'stream-event',
      event: { type: 'approval_request', approval },
    });
    return await decision;
  }

  public resolve(id: string, action: 'allow' | 'deny'): { readonly ok: true; readonly approvalId: string; readonly action: 'allow' | 'deny' } {
    const pending = this.pending.get(id);
    if (!pending) return { ok: true, approvalId: id, action };
    this.pending.delete(id);
    pending.resolve(action === 'allow'
      ? { action: 'allow' }
      : { action: 'deny', reason: 'denied in VS Code approval card' });
    void this.post({
      requestId: this.activeRequestId ?? id,
      kind: 'stream-event',
      event: { type: 'approval_resolved', approvalId: id, action },
    });
    return { ok: true, approvalId: id, action };
  }

  public cancelAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      pending.resolve({ action: 'deny', reason });
      void this.post({
        requestId: this.activeRequestId ?? id,
        kind: 'stream-event',
        event: { type: 'approval_resolved', approvalId: id, action: 'deny' },
      });
    }
    this.pending.clear();
  }

  private async post(message: BridgeResponse): Promise<void> {
    if (!this.webview) return;
    try {
      await this.webview.postMessage(message);
    } catch (error) {
      this.output.appendLine(`[approval] failed to post approval event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const createApprovalId = (): string =>
  `approval-${randomUUID()}`;

const sanitizeApprovalPreview = (input: unknown): string =>
  redactSecrets(formatUnknown(input, 2_000));

const redactSecrets = (text: string): string => {
  let redacted = text.replace(
    /("?(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|secret|authorization)"?\s*[:=]\s*)"[^"\n]{4,}"/gi,
    '$1"[redacted]"',
  );
  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi, 'Bearer [redacted]');
  redacted = redacted.replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, '[redacted]');
  redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]');
  return redacted;
};
