import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { AtlasError } from '@atlas/core/errors';
import type { LoopEvent } from '@atlas/core/loop';
import type { Result } from '@atlas/core/result';
import {
  BridgeRequestSchema,
  type BridgeResponse,
  createBridgeErrorResponse,
  createBridgeResponse,
  requestIdFromUnknown,
} from './bridge.js';
import type { AtlasSessionHost } from './session-host.js';

const VIEW_ID = 'atlas.sidebar';

export function activate(context: vscode.ExtensionContext): void {
  process.env['ATLAS_LOG_JSON'] ??= '1';

  const output = vscode.window.createOutputChannel('Atlas');
  const runtime = new AtlasRuntimeController(output);
  const provider = new AtlasSidebarProvider(context, output, runtime);

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.commands.registerCommand('atlas.open', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.atlas');
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand('atlas.runTurn', async () => {
      const prompt = await vscode.window.showInputBox({
        title: 'Atlas: Run Turn',
        prompt: 'Enter a prompt for Atlas.',
      });
      const trimmed = prompt?.trim();
      if (!trimmed) return;

      output.show(true);
      await runtime.runTurn(trimmed, {
        onEvent: (event) => appendLoopEvent(output, event),
        onError: (error) => output.appendLine(`[error] ${error.message}`),
      });
    }),
  );
}

export function deactivate(): void {
  // VS Code disposes registered subscriptions from the extension context.
}

class AtlasSidebarProvider implements vscode.WebviewViewProvider {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly runtime: AtlasRuntimeController,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    };

    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((rawMessage: unknown) => {
      this.handleMessage(webviewView.webview, rawMessage);
    });
  }

  private handleMessage(webview: vscode.Webview, rawMessage: unknown): void {
    const parsed = BridgeRequestSchema.safeParse(rawMessage);
    if (!parsed.success) {
      const requestId = requestIdFromUnknown(rawMessage) ?? 'unknown-request';
      void webview.postMessage(createBridgeErrorResponse(
        requestId,
        'Invalid Atlas bridge request.',
        'BRIDGE_INVALID_REQUEST',
      ));
      return;
    }

    const request = parsed.data;
    switch (request.kind) {
      case 'ping': {
        void webview.postMessage(createBridgeResponse(request.requestId, { ok: true, host: 'vscode' }));
        return;
      }
      case 'runTurn': {
        this.output.appendLine(`Atlas webview prompt: ${request.params.prompt}`);
        void this.runtime.runTurn(request.params.prompt, {
          onEvent: async (event) => {
            appendLoopEvent(this.output, event);
            const response = bridgeMessageFromLoopEvent(request.requestId, event);
            if (response) await webview.postMessage(response);
          },
          onError: async (error) => {
            await webview.postMessage(createBridgeErrorResponse(
              request.requestId,
              error.message,
              error.code,
            ));
          },
        }).then(async () => {
          await webview.postMessage(createBridgeResponse(request.requestId, { ok: true }));
        });
        return;
      }
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'index.css'),
    );
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <link rel="stylesheet" href="${styleUri}">
    <title>Atlas</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(32);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

interface RunTurnHandlers {
  readonly onEvent: (event: LoopEvent) => void | Promise<void>;
  readonly onError: (error: AtlasError) => void | Promise<void>;
}

class AtlasRuntimeController {
  private hostPromise: Promise<Result<AtlasSessionHost, AtlasError>> | null = null;

  public constructor(private readonly output: vscode.OutputChannel) {}

  public async runTurn(prompt: string, handlers: RunTurnHandlers): Promise<void> {
    const hostResult = await this.getHost();
    if (!hostResult.ok) {
      await handlers.onError(hostResult.error);
      return;
    }

    this.output.appendLine(
      `[atlas] ${hostResult.value.agentName} / ${hostResult.value.providerName} / ${hostResult.value.model}`,
    );
    for await (const event of hostResult.value.runTurn(prompt)) {
      await handlers.onEvent(event);
      if (event.type === 'error') await handlers.onError(event.error);
    }
  }

  private getHost(): Promise<Result<AtlasSessionHost, AtlasError>> {
    this.hostPromise ??= import('./session-host.js').then(({ createAtlasSessionHost }) =>
      createAtlasSessionHost({ cwd: workspaceCwd() })
    );
    return this.hostPromise;
  }
}

const workspaceCwd = (): string =>
  vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

const appendLoopEvent = (output: vscode.OutputChannel, event: LoopEvent): void => {
  switch (event.type) {
    case 'delta':
      output.append(event.text);
      return;
    case 'thinking':
      output.append(`[thinking] ${event.text}`);
      return;
    case 'tool_call_start':
      output.appendLine(`\n[tool] ${event.call.name} ${event.call.arguments}`);
      return;
    case 'tool_call_done':
      output.appendLine(event.outcome.type === 'ok'
        ? `[tool ok] ${event.call.name}: ${event.outcome.summary}`
        : `[tool error] ${event.call.name}: ${event.outcome.error.message}`);
      return;
    case 'turn_end':
      output.appendLine('');
      return;
    case 'done':
      output.appendLine(
        `[done] ${event.finishReason ?? 'complete'} (${event.rounds} round${event.rounds === 1 ? '' : 's'})`,
      );
      return;
    case 'error':
      output.appendLine(`[error] ${event.error.message}`);
      return;
  }
};

const bridgeMessageFromLoopEvent = (
  requestId: string,
  event: LoopEvent,
): BridgeResponse | null => {
  switch (event.type) {
    case 'delta':
      return { requestId, kind: 'stream-event', event: { type: 'delta', text: event.text } };
    case 'thinking':
      return { requestId, kind: 'stream-event', event: { type: 'thinking', text: event.text } };
    case 'tool_call_start':
      return { requestId, kind: 'stream-event', event: { type: 'tool_call', call: event.call } };
    case 'done':
      return {
        requestId,
        kind: 'stream-event',
        event: {
          type: 'done',
          finishReason: event.finishReason,
          ...(event.usage ? { usage: event.usage } : {}),
        },
      };
    case 'error':
      return createBridgeErrorResponse(requestId, event.error.message, event.error.code);
    case 'tool_call_done':
    case 'turn_end':
      return null;
  }
};
