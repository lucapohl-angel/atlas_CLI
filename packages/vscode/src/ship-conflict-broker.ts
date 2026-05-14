import type { OutputChannel, Webview } from 'vscode';

interface PendingShipConflict {
  readonly resolve: (result: { strategy: 'abort' | 'ours' | 'theirs' | 'ai'; persist: boolean } | null) => void;
}

export interface ShipConflictRequest {
  readonly id: string;
  readonly base: string;
  readonly branch: string;
  readonly conflictFiles: readonly string[];
}

export class ShipConflictBroker {
  private webview: Webview | null = null;
  private readonly pending = new Map<string, PendingShipConflict>();

  public constructor(private readonly output: OutputChannel) {}

  public attach(webview: Webview): void {
    this.webview = webview;
  }

  public detach(webview: Webview): void {
    if (this.webview === webview) this.webview = null;
  }

  public async request(
    params: { readonly base: string; readonly branch: string; readonly conflictFiles: readonly string[] },
    signal?: AbortSignal,
  ): Promise<{ strategy: 'abort' | 'ours' | 'theirs' | 'ai'; persist: boolean } | null> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.output.appendLine(`[ship conflict] ${params.branch} → ${params.conflictFiles.join(', ')}`);

    return new Promise((resolve) => {
      this.pending.set(id, { resolve });

      const post = async (): Promise<void> => {
        await this.webview?.postMessage({
          requestId: 'ship-conflict',
          kind: 'stream-event',
          event: {
            type: 'ship_conflict',
            conflict: { id, base: params.base, branch: params.branch, conflictFiles: params.conflictFiles },
          },
        });
      };
      void post();

      signal?.addEventListener('abort', () => {
        this.cancel(id);
      });
    });
  }

  public resolve(
    id: string,
    strategy: 'abort' | 'ours' | 'theirs' | 'ai',
    persist: boolean,
  ): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.resolve({ strategy, persist });
    this.pending.delete(id);
    void this.webview?.postMessage({
      requestId: 'ship-conflict',
      kind: 'stream-event',
      event: { type: 'ship_conflict_resolved', conflictId: id, strategy },
    });
  }

  public cancel(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.resolve(null);
    this.pending.delete(id);
  }

  public cancelAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      pending.resolve(null);
      this.output.appendLine(`[ship conflict] cancelled ${id}: ${reason}`);
    }
    this.pending.clear();
  }
}
