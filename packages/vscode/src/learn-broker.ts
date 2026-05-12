import { randomUUID } from 'node:crypto';
import type { Message, Provider } from '@atlas/core/providers';
import {
  buildReflectionMessages,
  buildSkillRevisionMessages,
  parseLearnedSkillDraft,
  type LearnedSkillDraft,
} from '@atlas/core';
import { type BridgeResponse } from './bridge.js';
import type { OutputChannel, Webview } from 'vscode';

export class LearnBroker {
  private webview: Webview | null = null;
  private activeRequestId: string | null = null;
  private reflectAbort: AbortController | null = null;
  private pendingDraft: LearnedSkillDraft | null = null;
  private pendingReason = '';

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

  public get currentDraft(): LearnedSkillDraft | null {
    return this.pendingDraft;
  }

  public get currentReason(): string {
    return this.pendingReason;
  }

  public clearDraft(): void {
    this.pendingDraft = null;
    this.pendingReason = '';
  }

  public async runReflection(
    provider: Provider,
    model: string,
    history: readonly Message[],
    reason: string,
    force: boolean,
  ): Promise<void> {
    this.cancelReflection();
    const abort = new AbortController();
    this.reflectAbort = abort;

    await this.post({
      requestId: this.activeRequestId ?? `learn-${randomUUID()}`,
      kind: 'stream-event',
      event: { type: 'learn_reflecting', reason },
    });

    const messages = buildReflectionMessages(history, reason, { force });
    let buf = '';

    try {
      for await (const event of provider.stream({ model, messages, signal: abort.signal })) {
        if (event.type === 'delta') {
          buf += event.text;
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (abort.signal.aborted) {
        await this.post({
          requestId: this.activeRequestId ?? `learn-${randomUUID()}`,
          kind: 'stream-event',
          event: { type: 'learn_error', error: 'Reflection cancelled' },
        });
      } else {
        await this.post({
          requestId: this.activeRequestId ?? `learn-${randomUUID()}`,
          kind: 'stream-event',
          event: { type: 'learn_error', error: msg },
        });
      }
      this.reflectAbort = null;
      return;
    }

    this.reflectAbort = null;

    const parsed = parseLearnedSkillDraft(buf);
    if (!parsed.ok) {
      await this.post({
        requestId: this.activeRequestId ?? `learn-${randomUUID()}`,
        kind: 'stream-event',
        event: { type: 'learn_error', error: parsed.error },
      });
      return;
    }

    if (parsed.draft === null) {
      this.pendingDraft = null;
      this.pendingReason = reason;
      await this.post({
        requestId: this.activeRequestId ?? `learn-${randomUUID()}`,
        kind: 'stream-event',
        event: { type: 'learn_nothing', reason, force },
      });
      return;
    }

    this.pendingDraft = parsed.draft;
    this.pendingReason = reason;
    await this.post({
      requestId: this.activeRequestId ?? `learn-${randomUUID()}`,
      kind: 'stream-event',
      event: {
        type: 'learn_review',
        draft: parsed.draft,
        reason,
      },
    });
  }

  public async runRevision(
    provider: Provider,
    model: string,
    draft: LearnedSkillDraft,
    changeRequest: string,
    reason: string,
  ): Promise<void> {
    this.cancelReflection();
    const abort = new AbortController();
    this.reflectAbort = abort;

    await this.post({
      requestId: this.activeRequestId ?? `learn-${randomUUID()}`,
      kind: 'stream-event',
      event: { type: 'learn_reflecting', reason: `Revising: ${reason}` },
    });

    const messages = buildSkillRevisionMessages(draft, changeRequest, reason);
    let buf = '';

    try {
      for await (const event of provider.stream({ model, messages, signal: abort.signal })) {
        if (event.type === 'delta') {
          buf += event.text;
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (abort.signal.aborted) {
        await this.post({
          requestId: this.activeRequestId ?? `learn-${randomUUID()}`,
          kind: 'stream-event',
          event: { type: 'learn_error', error: 'Revision cancelled' },
        });
      } else {
        await this.post({
          requestId: this.activeRequestId ?? `learn-${randomUUID()}`,
          kind: 'stream-event',
          event: { type: 'learn_error', error: msg },
        });
      }
      this.reflectAbort = null;
      return;
    }

    this.reflectAbort = null;

    const parsed = parseLearnedSkillDraft(buf);
    if (!parsed.ok) {
      await this.post({
        requestId: this.activeRequestId ?? `learn-${randomUUID()}`,
        kind: 'stream-event',
        event: { type: 'learn_error', error: parsed.error },
      });
      return;
    }

    if (parsed.draft === null) {
      this.pendingDraft = null;
      await this.post({
        requestId: this.activeRequestId ?? `learn-${randomUUID()}`,
        kind: 'stream-event',
        event: { type: 'learn_nothing', reason, force: false },
      });
      return;
    }

    this.pendingDraft = parsed.draft;
    await this.post({
      requestId: this.activeRequestId ?? `learn-${randomUUID()}`,
      kind: 'stream-event',
      event: {
        type: 'learn_review',
        draft: parsed.draft,
        reason,
      },
    });
  }

  public cancelReflection(): void {
    if (this.reflectAbort) {
      this.reflectAbort.abort();
      this.reflectAbort = null;
    }
  }

  private async post(message: BridgeResponse): Promise<void> {
    if (!this.webview) return;
    try {
      await this.webview.postMessage(message);
    } catch (error) {
      this.output.appendLine(
        `[learn] failed to post learn event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
