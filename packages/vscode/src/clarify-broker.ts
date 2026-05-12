import { randomUUID } from 'node:crypto';
import { type BridgeResponse } from './bridge.js';

// vscode is a peer dependency injected at runtime by the extension host.
// We use type-only imports so tests can load this module without the
// vscode package being present.
import type { OutputChannel, Webview } from 'vscode';

export interface InlineClarifyRequest {
  readonly id: string;
  readonly question: string;
  readonly choices: readonly string[];
  readonly allowFreeform: boolean;
}

interface PendingClarify {
  readonly request: InlineClarifyRequest;
  readonly resolve: (answer: string) => void;
  readonly reject: (reason: Error) => void;
}

export class InlineClarifyBroker {
  private webview: Webview | null = null;
  private activeRequestId: string | null = null;
  private readonly pending = new Map<string, PendingClarify>();

  public constructor(private readonly output: OutputChannel) {}

  public attach(webview: Webview): void {
    this.webview = webview;
  }

  public detach(webview: Webview): void {
    if (this.webview === webview) this.webview = null;
  }

  public setActiveRequestId(requestId: string | null): void {
    this.activeRequestId = requestId;
  }

  public async request(
    question: string,
    choices: readonly string[] | undefined,
    allowFreeform: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.webview) {
      throw new Error('No webview attached for inline clarify');
    }
    if (signal?.aborted) {
      throw new Error('clarify cancelled');
    }

    const clarify: InlineClarifyRequest = {
      id: `clarify-${randomUUID()}`,
      question,
      choices: choices ?? [],
      allowFreeform,
    };

    const answer = new Promise<string>((resolve, reject) => {
      this.pending.set(clarify.id, { request: clarify, resolve, reject });

      if (signal) {
        const onAbort = () => {
          this.pending.delete(clarify.id);
          reject(new Error('clarify cancelled'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    await this.post({
      requestId: this.activeRequestId ?? clarify.id,
      kind: 'stream-event',
      event: {
        type: 'clarify_request',
        clarify: {
          id: clarify.id,
          question: clarify.question,
          choices: clarify.choices.length > 0 ? [...clarify.choices] : undefined,
          allowFreeform: clarify.allowFreeform,
        },
      },
    });

    return await answer;
  }

  public resolve(clarifyId: string, answer: string): void {
    const pending = this.pending.get(clarifyId);
    if (!pending) return;
    this.pending.delete(clarifyId);
    pending.resolve(answer);
    void this.post({
      requestId: this.activeRequestId ?? clarifyId,
      kind: 'stream-event',
      event: { type: 'clarify_resolved', clarifyId, answer },
    });
  }

  public cancelAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      pending.reject(new Error(reason));
      void this.post({
        requestId: this.activeRequestId ?? id,
        kind: 'stream-event',
        event: { type: 'clarify_resolved', clarifyId: id, answer: '' },
      });
    }
    this.pending.clear();
  }

  private async post(message: BridgeResponse): Promise<void> {
    if (!this.webview) return;
    try {
      await this.webview.postMessage(message);
    } catch (error) {
      this.output.appendLine(
        `[clarify] failed to post clarify event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
