import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { loadAgents, isFrameworkAgent, type Agent } from '@atlas/core/agents';
import {
  builtinToolRegistry,
  DEFAULT_BUILTIN_MCP_SERVERS,
  MCP_SUGGESTIONS,
  SessionStore,
  type SessionRecord,
} from '@atlas/core';
import { type AtlasConfig, type McpServerConfig } from '@atlas/core/config';
import { atlasError, type AtlasError } from '@atlas/core/errors';
import type { LoopEvent } from '@atlas/core/loop';
import {
  beginCodexLogin,
  createAnthropicProvider,
  createCodexProvider,
  createLocalProvider,
  createOpenCodeProvider,
  createOpenRouterProvider,
  loadClaudeCodeCredentials,
  type CodexTokenSnapshot,
  type ContentBlock,
  type Message,
  type ModelProviderKind,
  type Provider,
  type ThinkingLevel,
} from '@atlas/core/providers';
import { err, ok, type Result } from '@atlas/core/result';
import type { TodoItem } from '@atlas/core/tools';
import { loadActiveTask, type TaskState } from '@atlas/core/workflow';
import {
  BridgeRequestSchema,
  type BridgeResponse,
  createBridgeErrorResponse,
  createBridgeResponse,
  requestIdFromUnknown,
} from './bridge.js';
import type { AtlasSessionHost } from './session-host.js';
import {
  allowedThinkingForSelection,
  buildVsCodeModelSummary,
  defaultProviderForModelProvider,
  loadVsCodeModelCatalog,
  loadVsCodeModelCatalogWithDiagnostics,
  type VsCodeModelCatalogDiagnostic,
  type VsCodeModelSummary,
} from './model-catalog.js';
import {
  createVsCodeApprovalPolicy,
  createVsCodeClarifyAsk,
  createVsCodeToolRegistry,
  type VsCodeToolHost,
} from './tools/index.js';
import { InlineApprovalBroker } from './approval-broker.js';
import { InlineClarifyBroker } from './clarify-broker.js';
import { LearnBroker } from './learn-broker.js';
import { shouldOfferLearn, describeLearnReason } from '@atlas/core';
import { saveLearnedSkill } from '@atlas/core/skills';
import {
  atlasConfigPath,
  clearStoredSecret,
  loadVsCodeConfig,
  promptAndStoreSecret,
  promptSecretLabel,
  saveVsCodeConfig,
  storeCodexTokens,
  storeSecretValue,
  updateVsCodeConfig,
  getVscodePowerMode,
  setVscodePowerMode,
  type PromptSecretKey,
  type SafeConfigUpdate,
} from './config-store.js';

const VIEW_ID = 'atlas.sidebar';
const ACTIVE_SESSION_KEY = 'atlas.activeSessionId';

interface SettingsSummaryProvider {
  readonly configured: boolean;
  readonly baseUrl: string;
  readonly fallbackKeys: number;
  readonly customModels: number;
}

interface SettingsToolSummary {
  readonly name: string;
  readonly description: string;
  readonly approval: 'auto' | 'ask' | 'never';
}

interface SettingsSummary {
  readonly ok: true;
  readonly configPath: string;
  readonly cwd: string;
  readonly defaultProvider: AtlasConfig['defaultProvider'];
  readonly defaultModel: string;
  readonly routerModel: string | null;
  readonly fallbackModels: number;
  readonly atlasMode: AtlasConfig['atlasMode'];
  readonly vscodePowerMode: 'lite' | 'hybrid' | 'full';
  readonly providers: {
    readonly openrouter: SettingsSummaryProvider;
    readonly anthropic: SettingsSummaryProvider & { readonly oauthEnabled: boolean };
    readonly openaiCodex: {
      readonly configured: boolean;
      readonly baseUrl: string;
      readonly accountId: string | null;
      readonly expiresAt: number | null;
      readonly apiKeyConfigured: boolean;
      readonly oauthConfigured: boolean;
      readonly authMode: AtlasConfig['providers']['openai']['authMode'];
    };
    readonly opencodeZen: SettingsSummaryProvider;
    readonly opencodeGo: SettingsSummaryProvider;
    readonly local: SettingsSummaryProvider & { readonly autoDetect: boolean; readonly toolMode: string; readonly requestTimeoutMs: number; readonly apiKeyConfigured: boolean };
  };
  readonly mcp: { readonly servers: number; readonly active: number; readonly disabled: number; readonly builtinsSeeded: boolean };
  readonly github: { readonly configured: boolean; readonly login: string | null };
  readonly compaction: { readonly enabled: boolean; readonly model: string | null; readonly threshold: number; readonly contextTokens: number };
  readonly guardrails: {
    readonly enabled: boolean;
    readonly dangerousCommand: boolean;
    readonly pathSafety: boolean;
    readonly secretRedaction: boolean;
    readonly promptInjectionDetector: boolean;
    readonly discoverGuardrails: boolean;
    readonly progressTracker: boolean;
    readonly extraDeniedPaths: number;
    readonly extraDeniedCommands: number;
  };
  readonly ship: { readonly autoResolve: AtlasConfig['ship']['autoResolve']; readonly promptOnConflict: boolean };
  readonly directories: { readonly agents: string; readonly skills: string };
  readonly commands: { readonly vscodeSetup: string };
  readonly tools: readonly SettingsToolSummary[];
}

interface SettingsSummaryError {
  readonly ok: false;
  readonly configPath: string;
  readonly cwd: string;
  readonly error: { readonly message: string; readonly code: string };
}

type SettingsSummaryResult = SettingsSummary | SettingsSummaryError;

interface ModelSummaryResult {
  readonly ok: true;
  readonly activeModel: string;
  readonly activeProvider: ModelProviderKind;
  readonly activeThinking: ThinkingLevel;
  readonly models: readonly VsCodeModelSummary[];
  readonly diagnostics: readonly VsCodeModelCatalogDiagnostic[];
}

interface AgentSummary {
  readonly name: string;
  readonly role: string;
  readonly description: string;
  readonly kind: Agent['kind'];
  readonly active: boolean;
  readonly switchable: boolean;
}

interface AgentSummaryResult {
  readonly ok: true;
  readonly activeAgent: string;
  readonly switchableCount: number;
  readonly agents: readonly AgentSummary[];
}

interface McpServerSummary {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly source: 'configured' | 'catalog' | 'builtin';
  readonly status: 'running' | 'disabled' | 'not-configured' | 'not-started' | 'failed';
  readonly tools: number;
  readonly summary: string;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly url: string | null;
  readonly docs: string | null;
  readonly error: string | null;
}

interface McpStatusResult {
  readonly ok: true;
  readonly servers: readonly McpServerSummary[];
  readonly configured: number;
  readonly enabled: number;
  readonly active: number;
  readonly note: string;
}

interface SessionSummary {
  readonly id: string;
  readonly updatedAt: string;
  readonly title: string | null;
  readonly active: boolean;
}

interface SessionListResult {
  readonly ok: true;
  readonly sessions: readonly SessionSummary[];
  readonly activeSessionId: string | null;
}

interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly phase: TaskState['phase'];
  readonly note: string | null;
  readonly updatedAt: string;
  readonly contextDocPath: string | null;
  readonly planDocPath: string | null;
}

interface TaskStatusResult {
  readonly ok: true;
  readonly task: TaskSummary | null;
}

interface TodoStatusResult {
  readonly ok: true;
  readonly todos: readonly TodoItem[];
}

interface RuntimeActionError {
  readonly ok: false;
  readonly error: { readonly message: string; readonly code: string };
}

export function activate(context: vscode.ExtensionContext): void {
  process.env['ATLAS_LOG_JSON'] ??= '1';

  const output = vscode.window.createOutputChannel('Atlas');
  const approvals = new InlineApprovalBroker(output);
  const clarifyBroker = new InlineClarifyBroker(output);
  const learnBroker = new LearnBroker(output);
  const runtime = new AtlasRuntimeController(context, output, approvals, clarifyBroker, learnBroker);
  const provider = new AtlasSidebarProvider(context, output, runtime, approvals, clarifyBroker, learnBroker);

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.window.registerUriHandler(new AtlasUriHandler(output)),
    vscode.commands.registerCommand('atlas.open', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.atlas');
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand('atlas.signInCodex', async () => {
      await signInCodex(context, output);
    }),
    vscode.commands.registerCommand('atlas.runTurn', async () => {
      const prompt = await vscode.window.showInputBox({
        title: 'Atlas: Run Turn',
        prompt: 'Enter a prompt for Atlas.',
      });
      const trimmed = prompt?.trim();
      if (!trimmed) return;

      output.show(true);
      await runtime.runTurn(trimmed, [], {
        onEvent: (event) => appendLoopEvent(output, event),
        onError: (error) => output.appendLine(`[error] ${error.message}`),
      });
    }),
  );
}

export function deactivate(): void {
  // VS Code disposes registered subscriptions from the extension context.
}

class AtlasUriHandler implements vscode.UriHandler {
  public constructor(private readonly output: vscode.OutputChannel) {}

  public handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
    this.output.appendLine(`[auth] received VS Code URI callback: ${uri.toString(true)}`);
    void vscode.window.showInformationMessage('Atlas received an auth callback. Return to the Atlas sidebar to continue.');
  }
}

const signInCodex = async (
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<Result<{ readonly configured: true; readonly accountId: string | null }, AtlasError>> => {
  output.appendLine('[auth] starting ChatGPT / Codex sign-in');
  const controller = new AbortController();
  const handle = beginCodexLogin({
    signal: controller.signal,
    openBrowser: async (url) => {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
  });
  const result = await handle.tokens;
  if (!result.ok) {
    output.appendLine(`[auth] ChatGPT / Codex sign-in failed: ${result.error.message}`);
    await vscode.window.showErrorMessage(result.error.message);
    return err(result.error);
  }
  await storeCodexTokens(context, result.value);
  const configResult = await loadVsCodeConfig(context);
  if (!configResult.ok) {
    await vscode.window.showErrorMessage(configResult.error.message);
    return err(configResult.error);
  }
  const nextConfig: AtlasConfig = {
    ...configResult.value,
    providers: {
      ...configResult.value.providers,
      openai: {
        ...configResult.value.providers.openai,
        codex: result.value,
      },
    },
  };
  const saved = await saveVsCodeConfig(context, nextConfig);
  if (!saved.ok) {
    await vscode.window.showErrorMessage(saved.error.message);
    return err(saved.error);
  }
  await vscode.window.showInformationMessage('Atlas ChatGPT / Codex sign-in is complete.');
  return ok({ configured: true, accountId: result.value.accountId ?? null });
};

class AtlasSidebarProvider implements vscode.WebviewViewProvider {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly runtime: AtlasRuntimeController,
    private readonly approvals: InlineApprovalBroker,
    private readonly clarifyBroker: InlineClarifyBroker,
    private readonly learnBroker: LearnBroker,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    };

    webviewView.webview.html = this.renderHtml(webviewView.webview);
    this.approvals.attach(webviewView.webview);
    this.clarifyBroker.attach(webviewView.webview);
    this.learnBroker.attach(webviewView.webview);
    webviewView.onDidDispose(() => {
      this.approvals.detach(webviewView.webview);
      this.clarifyBroker.detach(webviewView.webview);
      this.learnBroker.detach(webviewView.webview);
    });
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
      case 'getStatus': {
        void this.runtime.getStatus().then(async (status) => {
          await webview.postMessage(createBridgeResponse(request.requestId, status));
        });
        return;
      }
      case 'getSettings': {
        void getSettingsSummary(this.context).then(async (settings) => {
          await webview.postMessage(createBridgeResponse(request.requestId, settings));
        });
        return;
      }
      case 'openConfig': {
        void openConfigFile().then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        }).catch(async (error: unknown) => {
          await webview.postMessage(createBridgeErrorResponse(
            request.requestId,
            error instanceof Error ? error.message : 'Failed to open Atlas config.',
            'CONFIG_OPEN_FAILED',
          ));
        });
        return;
      }
      case 'openFile': {
        void openWorkspaceFile(request.params).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        }).catch(async (error: unknown) => {
          await webview.postMessage(createBridgeErrorResponse(
            request.requestId,
            error instanceof Error ? error.message : 'Failed to open workspace file.',
            'FILE_OPEN_FAILED',
          ));
        });
        return;
      }
      case 'getModels': {
        void this.runtime.getModels(request.params.forceRefresh ?? false).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        }).catch(async (error: unknown) => {
          await webview.postMessage(createBridgeErrorResponse(
            request.requestId,
            error instanceof Error ? error.message : 'Failed to load Atlas models.',
            'MODELS_LOAD_FAILED',
          ));
        });
        return;
      }
      case 'selectModel': {
        void this.runtime.selectModel(request.params).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'getAgents': {
        void this.runtime.getAgents().then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        }).catch(async (error: unknown) => {
          await webview.postMessage(createBridgeErrorResponse(
            request.requestId,
            error instanceof Error ? error.message : 'Failed to load Atlas agents.',
            'AGENTS_LOAD_FAILED',
          ));
        });
        return;
      }
      case 'selectAgent': {
        void this.runtime.selectAgent(request.params.name).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'getMcpStatus': {
        void this.runtime.getMcpStatus().then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        }).catch(async (error: unknown) => {
          await webview.postMessage(createBridgeErrorResponse(
            request.requestId,
            error instanceof Error ? error.message : 'Failed to load MCP status.',
            'MCP_STATUS_FAILED',
          ));
        });
        return;
      }
      case 'getSessions': {
        void this.runtime.getSessions().then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'resumeSession': {
        void this.runtime.resumeSession(request.params.id).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'newSession': {
        void this.runtime.newSession().then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'renameSession': {
        void this.runtime.renameSession(request.params.id, request.params.title).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'deleteSession': {
        void this.runtime.deleteSession(request.params.id).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'promptRenameSession': {
        void this.runtime.promptRenameSession(request.params.id, request.params.title ?? null).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'getTaskStatus': {
        void this.runtime.getTaskStatus().then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        }).catch(async (error: unknown) => {
          await webview.postMessage(createBridgeErrorResponse(
            request.requestId,
            error instanceof Error ? error.message : 'Failed to load task status.',
            'TASK_STATUS_FAILED',
          ));
        });
        return;
      }
      case 'getTodos': {
        void this.runtime.getTodos().then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'resolveApproval': {
        const result = this.approvals.resolve(request.params.approvalId, request.params.action);
        void webview.postMessage(createBridgeResponse(request.requestId, result));
        return;
      }
      case 'promptSecret': {
        void this.runtime.promptSecret(request.params.key).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'clearSecret': {
        void this.runtime.clearSecret(request.params.key).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'storeSecret': {
        void this.runtime.storeSecret(request.params.key, request.params.value).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'signInCodex': {
        void signInCodex(this.context, this.output).then(async (result) => {
          await webview.postMessage(createBridgeResponse(
            request.requestId,
            result.ok
              ? { ok: true, codexSignIn: true, configured: true, accountId: result.value.accountId }
              : runtimeError(result.error),
          ));
        });
        return;
      }
      case 'updateSettings': {
        void this.runtime.updateSettings(request.params).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'setMcpEnabled': {
        void this.runtime.setMcpEnabled(request.params.name, request.params.enabled).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'addMcpServer': {
        void this.runtime.addMcpServer(request.params.name).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'upsertMcpServer': {
        void this.runtime.upsertMcpServer(request.params).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'removeMcpServer': {
        void this.runtime.removeMcpServer(request.params.name).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'setMode': {
        const result = this.runtime.setMode(request.params.mode);
        void webview.postMessage(createBridgeResponse(request.requestId, result));
        return;
      }
      case 'setThinking': {
        void this.runtime.setThinking(request.params.level).then(async (result) => {
          await webview.postMessage(createBridgeResponse(request.requestId, result));
        });
        return;
      }
      case 'cancelTurn': {
        const result = this.runtime.cancelTurn();
        void webview.postMessage(createBridgeResponse(request.requestId, result));
        return;
      }
      case 'runTurn': {
        this.output.appendLine(`Atlas webview prompt: ${request.params.prompt}`);
        this.approvals.setActiveRequestId(request.requestId);
        const attachments = request.params.attachments ?? [];
        void this.runtime.runTurn(request.params.prompt, attachments, {
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
        }).finally(() => {
          this.approvals.setActiveRequestId(null);
        });
        return;
      }
      case 'attachFile': {
        void (async () => {
          const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: 'Attach',
            filters: request.params.type === 'image'
              ? { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }
              : undefined,
          });
          if (!result || result.length === 0) {
            await webview.postMessage(createBridgeResponse(request.requestId, { ok: true, cancelled: true }));
            return;
          }
          const file = result[0]!;
          try {
            if (request.params.type === 'image') {
              const buffer = await readFile(file.fsPath);
              const base64 = buffer.toString('base64');
              const mediaType = mimeTypeFromExt(extname(file.fsPath));
              await webview.postMessage(createBridgeResponse(request.requestId, {
                ok: true,
                path: file.fsPath,
                base64,
                mediaType,
              }));
            } else {
              const content = await readFile(file.fsPath, 'utf8');
              await webview.postMessage(createBridgeResponse(request.requestId, {
                ok: true,
                path: file.fsPath,
                content,
              }));
            }
          } catch (e) {
            await webview.postMessage(createBridgeErrorResponse(
              request.requestId,
              `Failed to read file: ${(e as Error).message}`,
              'READ_ERROR',
            ));
          }
        })();
        return;
      }
      case 'resolveClarify': {
        this.clarifyBroker.resolve(request.params.clarifyId, request.params.answer);
        void webview.postMessage(createBridgeResponse(request.requestId, { ok: true }));
        return;
      }
      case 'resolveLearn': {
        void (async () => {
          const { action, changeRequest } = request.params;

          if (action === 'discard') {
            this.learnBroker.clearDraft();
            await webview.postMessage(createBridgeResponse(request.requestId, { ok: true }));
            return;
          }

          const draft = this.learnBroker.currentDraft;
          const reason = this.learnBroker.currentReason;
          if (!draft) {
            await webview.postMessage(createBridgeErrorResponse(request.requestId, 'No learn draft is currently pending.', 'LEARN_NO_DRAFT'));
            return;
          }

          if (action === 'save') {
            const hostResult = await this.runtime.getHost();
            if (!hostResult.ok) {
              await webview.postMessage(createBridgeErrorResponse(request.requestId, hostResult.error.message, hostResult.error.code));
              return;
            }
            const host = hostResult.value;
            const r = await saveLearnedSkill({
              name: draft.name,
              description: draft.description,
              triggers: draft.triggers,
              body: draft.body,
              createdBy: host.agentName,
              createdReason: reason,
            });
            if (r.ok) {
              host.skills.add(r.value);
              await webview.postMessage({
                requestId: request.requestId,
                kind: 'stream-event',
                event: { type: 'learn_saved', name: r.value.name, description: r.value.description },
              });
            } else {
              await webview.postMessage(createBridgeErrorResponse(request.requestId, r.error.message, r.error.code));
            }
            this.learnBroker.clearDraft();
            return;
          }

          if (action === 'edit' && changeRequest) {
            const hostResult = await this.runtime.getHost();
            if (!hostResult.ok) {
              await webview.postMessage(createBridgeErrorResponse(request.requestId, hostResult.error.message, hostResult.error.code));
              return;
            }
            const host = hostResult.value;
            void this.learnBroker.runRevision(
              host.provider,
              host.model,
              draft,
              changeRequest,
              reason,
            );
            await webview.postMessage(createBridgeResponse(request.requestId, { ok: true }));
            return;
          }

          await webview.postMessage(createBridgeResponse(request.requestId, { ok: true }));
        })();
        return;
      }
      case 'runLearnReflection': {
        void (async () => {
          const hostResult = await this.runtime.getHost();
          if (!hostResult.ok) {
            await webview.postMessage(createBridgeErrorResponse(request.requestId, hostResult.error.message, hostResult.error.code));
            return;
          }
          const host = hostResult.value;
          const reason = describeLearnReason(0, 0, 'manual /learn');
          void this.learnBroker.runReflection(
            host.provider,
            host.model,
            host.history,
            reason,
            request.params.force ?? false,
          );
          await webview.postMessage(createBridgeResponse(request.requestId, { ok: true }));
        })();
        return;
      }
      case 'setLearnEnabled': {
        this.runtime.setLearnEnabled(request.params.enabled);
        void webview.postMessage(createBridgeResponse(request.requestId, { ok: true }));
        return;
      }
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const cacheBust = Date.now().toString();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js'),
    ).toString() + `?v=${cacheBust}`;
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'index.css'),
    ).toString() + `?v=${cacheBust}`;
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
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

async function getSettingsSummary(context: vscode.ExtensionContext): Promise<SettingsSummaryResult> {
  const configPath = atlasConfigPath();
  const configResult = await loadVsCodeConfig(context);
  if (!configResult.ok) {
    return {
      ok: false,
      configPath,
      cwd: workspaceCwd(),
      error: { message: configResult.error.message, code: configResult.error.code },
    };
  }

  const cfg = configResult.value;
  const openrouter = cfg.providers.openrouter;
  const anthropic = cfg.providers.anthropic;
  const opencodeZen = cfg.providers.opencode.zen;
  const opencodeGo = cfg.providers.opencode.go;
  const local = cfg.providers.local;
  const activeMcpServers = cfg.mcp.servers.filter((server) => server.enabled).length;

  return {
    ok: true,
    configPath,
    cwd: workspaceCwd(),
    defaultProvider: cfg.defaultProvider,
    defaultModel: cfg.defaultModel,
    routerModel: cfg.routerModel ?? null,
    fallbackModels: cfg.fallbackModels.length,
    atlasMode: cfg.atlasMode,
    vscodePowerMode: getVscodePowerMode() ?? 'full',
    providers: {
      openrouter: {
        configured: openrouter.apiKey !== undefined,
        baseUrl: openrouter.baseUrl,
        fallbackKeys: openrouter.apiKeys.length,
        customModels: openrouter.customModels.length,
      },
      anthropic: {
        configured: anthropic.apiKey !== undefined,
        baseUrl: anthropic.baseUrl,
        fallbackKeys: anthropic.apiKeys.length,
        customModels: 0,
        oauthEnabled: anthropic.useClaudeCodeOauth,
      },
      openaiCodex: {
        configured: cfg.providers.openai.codex.accessToken !== undefined || cfg.providers.openai.apiKey !== undefined,
        baseUrl: cfg.providers.openai.baseUrl,
        accountId: cfg.providers.openai.codex.accountId ?? null,
        expiresAt: cfg.providers.openai.codex.expiresAt ?? null,
        apiKeyConfigured: cfg.providers.openai.apiKey !== undefined,
        oauthConfigured: cfg.providers.openai.codex.accessToken !== undefined,
        authMode: cfg.providers.openai.authMode,
      },
      opencodeZen: {
        configured: opencodeZen.apiKey !== undefined,
        baseUrl: opencodeZen.baseUrl,
        fallbackKeys: 0,
        customModels: opencodeZen.customModels.length,
      },
      opencodeGo: {
        configured: opencodeGo.apiKey !== undefined,
        baseUrl: opencodeGo.baseUrl,
        fallbackKeys: 0,
        customModels: opencodeGo.customModels.length,
      },
      local: {
        configured: true,
        baseUrl: local.baseUrl,
        fallbackKeys: 0,
        customModels: local.customModels.length,
        autoDetect: local.autoDetect,
        toolMode: local.toolMode,
        requestTimeoutMs: local.requestTimeoutMs,
        apiKeyConfigured: local.apiKey !== undefined,
      },
    },
    mcp: {
      servers: cfg.mcp.servers.length,
      active: activeMcpServers,
      disabled: cfg.mcp.servers.length - activeMcpServers,
      builtinsSeeded: cfg.mcp.builtinsSeeded,
    },
    github: { configured: cfg.github.token !== undefined, login: cfg.github.login ?? null },
    compaction: {
      enabled: cfg.compaction.enabled,
      model: cfg.compaction.model ?? null,
      threshold: cfg.compaction.threshold,
      contextTokens: cfg.compaction.contextTokens,
    },
    guardrails: {
      enabled: cfg.guardrails.enabled,
      dangerousCommand: cfg.guardrails.dangerousCommand,
      pathSafety: cfg.guardrails.pathSafety,
      secretRedaction: cfg.guardrails.secretRedaction,
      promptInjectionDetector: cfg.guardrails.promptInjectionDetector,
      discoverGuardrails: cfg.guardrails.discoverGuardrails,
      progressTracker: cfg.guardrails.progressTracker,
      extraDeniedPaths: cfg.guardrails.extraDeniedPaths.length,
      extraDeniedCommands: cfg.guardrails.extraDeniedCommands.length,
    },
    ship: {
      autoResolve: cfg.ship.autoResolve,
      promptOnConflict: cfg.ship.promptOnConflict,
    },
    directories: {
      agents: '~/.atlas/agents',
      skills: '~/.atlas/skills',
    },
    commands: {
      vscodeSetup: 'atlas vscode-setup',
    },
    tools: builtinToolRegistry()
      .list()
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        approval: tool.approval,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function openConfigFile(): Promise<{ readonly ok: true; readonly path: string }> {
  const configPath = atlasConfigPath();
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(configPath));
  return { ok: true, path: configPath };
}

async function openWorkspaceFile(params: {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}): Promise<{ readonly ok: true; readonly path: string; readonly absolutePath: string; readonly line: number | null }> {
  const resolved = resolveWorkspaceFilePath(params.path);
  const uri = vscode.Uri.file(resolved.abs);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });

  if (params.line !== undefined) {
    const position = new vscode.Position(
      Math.max(0, params.line - 1),
      Math.max(0, (params.column ?? 1) - 1),
    );
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  return {
    ok: true,
    path: resolved.rel || resolved.abs,
    absolutePath: resolved.abs,
    line: params.line ?? null,
  };
}

function resolveWorkspaceFilePath(inputPath: string): { readonly abs: string; readonly rel: string } {
  const cwd = workspaceCwd();
  const abs = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
  const rel = relative(cwd, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to open a file outside the workspace: ${inputPath}`);
  }
  return { abs, rel };
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
  private readonly sessionStore = new SessionStore();
  private activeSessionId: string | null = null;
  private selectedModel: string | null = null;
  private selectedProvider: ModelProviderKind | null = null;
  private selectedAgent: string | null = null;
  private selectedThinking: ThinkingLevel = 'off';
  private currentMode: 'plan' | 'build' | 'autopilot' = 'plan';
  private initialMessages: readonly Message[] = [];
  private lastTodos: readonly TodoItem[] = [];
  private currentAbortController: AbortController | null = null;

  private learnEnabled = true;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly approvals: InlineApprovalBroker,
    private readonly clarifyBroker: InlineClarifyBroker,
    private readonly learnBroker: LearnBroker,
  ) {
    this.activeSessionId = context.globalState.get<string>(ACTIVE_SESSION_KEY) ?? null;
  }

  public async getStatus(): Promise<{
    readonly ok: boolean;
    readonly cwd: string;
    readonly agentName?: string;
    readonly providerName?: string;
    readonly model?: string;
    readonly mode?: 'plan' | 'build' | 'autopilot';
    readonly thinking?: ThinkingLevel;
    readonly error?: { readonly message: string; readonly code: string };
  }> {
    const hostResult = await this.getHost();
    if (!hostResult.ok) {
      return {
        ok: false,
        cwd: workspaceCwd(),
        error: { message: hostResult.error.message, code: hostResult.error.code },
      };
    }
    return {
      ok: true,
      cwd: workspaceCwd(),
      agentName: hostResult.value.agentName,
      providerName: hostResult.value.providerName,
      model: hostResult.value.model,
      mode: this.currentMode,
      thinking: this.selectedThinking,
    };
  }

  public async getModels(forceRefresh: boolean): Promise<ModelSummaryResult> {
    const configResult = await loadVsCodeConfig(this.context);
    if (!configResult.ok) throw new Error(configResult.error.message);
    const config = configResult.value;
    const activeProvider = this.selectedProvider ?? defaultProviderKind(config.defaultProvider);
    const activeModel = this.selectedModel ?? config.defaultModel;
    const catalog = await loadVsCodeModelCatalogWithDiagnostics(config, { forceRefresh });
    const models = buildVsCodeModelSummary(config, catalog.models, { activeModel, activeProvider });
    const active = models.find((model) => model.active);
    const activeThinking = normalizeThinking(this.selectedThinking, active?.thinking ?? ['off']);
    this.selectedThinking = activeThinking;
    return {
      ok: true,
      activeModel,
      activeProvider,
      activeThinking,
      models,
      diagnostics: catalog.diagnostics,
    };
  }

  public async selectModel(params: {
    readonly id: string;
    readonly provider: ModelProviderKind;
    readonly thinking?: ThinkingLevel;
  }): Promise<{
    readonly ok: true;
    readonly model: string;
    readonly provider: ModelProviderKind;
    readonly thinking: ThinkingLevel;
    readonly configPath: string;
    readonly persistedProvider: AtlasConfig['defaultProvider'] | null;
  } | RuntimeActionError> {
    const configResult = await loadVsCodeConfig(this.context);
    if (!configResult.ok) return runtimeError(configResult.error);

    const catalog = await loadVsCodeModelCatalog(configResult.value);
    const allowedThinking = allowedThinkingForSelection(params.id, params.provider, catalog);
    if (params.thinking && !allowedThinking.includes(params.thinking)) {
      return runtimeError(atlasError(
        'CONFIG_INVALID',
        `${params.id} does not support thinking=${params.thinking}. Allowed: ${allowedThinking.join('|')}`,
      ));
    }

    const thinking = normalizeThinking(params.thinking ?? this.selectedThinking, allowedThinking);
    const persistedProvider = defaultProviderForModelProvider(params.provider);
    const nextConfig: AtlasConfig = {
      ...configResult.value,
      ...(persistedProvider ? { defaultProvider: persistedProvider } : {}),
      defaultModel: params.id,
    };
    if (params.provider === 'local') {
      await setVscodePowerMode('lite');
      nextConfig.providers.local.toolMode = 'lite';
      nextConfig.providers.local.liteMode = true;
    }
    const saved = await saveVsCodeConfig(this.context, nextConfig);
    if (!saved.ok) return runtimeError(saved.error);

    this.selectedModel = params.id;
    this.selectedProvider = params.provider;
    this.selectedThinking = thinking;
    this.resetHost();
    return {
      ok: true,
      model: params.id,
      provider: params.provider,
      thinking,
      configPath: saved.value.path,
      persistedProvider,
    };
  }

  public async getAgents(): Promise<AgentSummaryResult> {
    const agentsResult = await loadAgents({ cwd: workspaceCwd() });
    if (!agentsResult.ok) throw new Error(agentsResult.error.message);
    const activeAgent = this.selectedAgent ?? 'atlas';
    const agents = agentsResult.value.map((agent): AgentSummary => {
      const switchable = isSwitchableAgent(agent);
      return {
        name: agent.name,
        role: agent.role,
        description: agent.description,
        kind: agent.kind,
        active: agent.name === activeAgent,
        switchable,
      };
    }).sort(compareAgentSummaries);
    return {
      ok: true,
      activeAgent,
      switchableCount: agents.filter((agent) => agent.switchable).length,
      agents,
    };
  }

  public async selectAgent(name: string): Promise<{
    readonly ok: true;
    readonly agent: string;
  } | RuntimeActionError> {
    const agentsResult = await loadAgents({ cwd: workspaceCwd() });
    if (!agentsResult.ok) return runtimeError(agentsResult.error);
    const agent = agentsResult.value.find((candidate) => candidate.name === name);
    if (!agent) return runtimeError(atlasError('AGENT_NOT_FOUND', `Atlas agent not found: ${name}`));
    if (!isSwitchableAgent(agent)) {
      return runtimeError(atlasError(
        'CONFIG_INVALID',
        `${name} is a framework specialist. Use Atlas routing instead of selecting it manually.`,
      ));
    }
    this.selectedAgent = name;
    this.resetHost();
    return { ok: true, agent: name };
  }

  public async getMcpStatus(): Promise<McpStatusResult> {
    const configResult = await loadVsCodeConfig(this.context);
    if (!configResult.ok) throw new Error(configResult.error.message);
    const rows = mcpRowsFromConfig(configResult.value.mcp.servers);
    return {
      ok: true,
      servers: rows,
      configured: rows.filter((row) => row.configured).length,
      enabled: rows.filter((row) => row.configured && row.enabled).length,
      active: rows.filter((row) => row.status === 'running').length,
      note: 'VS Code writes safe MCP add, enable, disable, and remove changes through Atlas config. Servers start on the next Atlas turn.',
    };
  }

  public async setMcpEnabled(name: string, enabled: boolean): Promise<{
    readonly ok: true;
    readonly mcp: string;
    readonly enabled: boolean;
  } | RuntimeActionError> {
    const configResult = await loadVsCodeConfig(this.context);
    if (!configResult.ok) return runtimeError(configResult.error);
    const exists = configResult.value.mcp.servers.some((server) => server.name === name);
    if (!exists) return runtimeError(atlasError('CONFIG_INVALID', `MCP server is not configured: ${name}`));
    const nextConfig: AtlasConfig = {
      ...configResult.value,
      mcp: {
        ...configResult.value.mcp,
        servers: configResult.value.mcp.servers.map((server) => (
          server.name === name ? { ...server, enabled } : server
        )),
      },
    };
    const saved = await saveVsCodeConfig(this.context, nextConfig);
    if (!saved.ok) return runtimeError(saved.error);
    return { ok: true, mcp: name, enabled };
  }

  public async addMcpServer(name: string): Promise<{
    readonly ok: true;
    readonly mcp: string;
    readonly added: boolean;
    readonly enabled: boolean;
  } | RuntimeActionError> {
    const configResult = await loadVsCodeConfig(this.context);
    if (!configResult.ok) return runtimeError(configResult.error);
    if (configResult.value.mcp.servers.some((server) => server.name === name)) {
      return { ok: true, mcp: name, added: false, enabled: true };
    }
    const server = mcpServerConfigFromCatalog(name);
    if (!server) return runtimeError(atlasError('CONFIG_INVALID', `Unknown MCP catalog server: ${name}`));
    const nextConfig: AtlasConfig = {
      ...configResult.value,
      mcp: {
        ...configResult.value.mcp,
        servers: [...configResult.value.mcp.servers, server],
      },
    };
    const saved = await saveVsCodeConfig(this.context, nextConfig);
    if (!saved.ok) return runtimeError(saved.error);
    return { ok: true, mcp: name, added: true, enabled: server.enabled };
  }

  public async upsertMcpServer(server: {
    readonly name: string;
    readonly transport: 'stdio' | 'http';
    readonly command?: string;
    readonly args?: readonly string[];
    readonly url?: string;
    readonly enabled: boolean;
  }): Promise<{
    readonly ok: true;
    readonly mcp: string;
    readonly updated: boolean;
    readonly enabled: boolean;
  } | RuntimeActionError> {
    const configResult = await loadVsCodeConfig(this.context);
    if (!configResult.ok) return runtimeError(configResult.error);
    if (server.transport === 'stdio' && !server.command) {
      return runtimeError(atlasError('CONFIG_INVALID', 'stdio MCP servers require a command.'));
    }
    if (server.transport === 'http' && !server.url) {
      return runtimeError(atlasError('CONFIG_INVALID', 'HTTP MCP servers require a URL.'));
    }
    const nextServer = {
      name: server.name,
      transport: server.transport,
      enabled: server.enabled,
      args: server.transport === 'stdio' ? [...(server.args ?? [])] : [],
      env: {},
      headers: {},
      ...(server.transport === 'stdio' ? { command: server.command ?? '' } : {}),
      ...(server.transport === 'http' ? { url: server.url } : {}),
    };
    const exists = configResult.value.mcp.servers.some((item) => item.name === server.name);
    const nextConfig: AtlasConfig = {
      ...configResult.value,
      mcp: {
        ...configResult.value.mcp,
        servers: exists
          ? configResult.value.mcp.servers.map((item) => item.name === server.name ? nextServer : item)
          : [...configResult.value.mcp.servers, nextServer],
      },
    };
    const saved = await saveVsCodeConfig(this.context, nextConfig);
    if (!saved.ok) return runtimeError(saved.error);
    return { ok: true, mcp: server.name, updated: true, enabled: server.enabled };
  }

  public async removeMcpServer(name: string): Promise<{
    readonly ok: true;
    readonly mcp: string;
    readonly removed: boolean;
  } | RuntimeActionError> {
    const configResult = await loadVsCodeConfig(this.context);
    if (!configResult.ok) return runtimeError(configResult.error);
    const nextServers = configResult.value.mcp.servers.filter((server) => server.name !== name);
    const removed = nextServers.length !== configResult.value.mcp.servers.length;
    if (!removed) return { ok: true, mcp: name, removed: false };
    const nextConfig: AtlasConfig = {
      ...configResult.value,
      mcp: {
        ...configResult.value.mcp,
        servers: nextServers,
      },
    };
    const saved = await saveVsCodeConfig(this.context, nextConfig);
    if (!saved.ok) return runtimeError(saved.error);
    return { ok: true, mcp: name, removed: true };
  }

  public async getSessions(): Promise<SessionListResult | RuntimeActionError> {
    const listed = await this.sessionStore.list();
    if (!listed.ok) return runtimeError(listed.error);
    return {
      ok: true,
      sessions: listed.value.map((session) => ({
        id: session.id,
        updatedAt: session.updatedAt,
        title: session.title ?? null,
        active: session.id === this.activeSessionId,
      })),
      activeSessionId: this.activeSessionId,
    };
  }

  public async resumeSession(id: string): Promise<{
    readonly ok: true;
    readonly session: SessionSummary;
  } | RuntimeActionError> {
    const loaded = await this.sessionStore.load(id);
    if (!loaded.ok) return runtimeError(loaded.error);
    await this.setActiveSessionId(loaded.value.id);
    this.initialMessages = loaded.value.messages;
    this.lastTodos = [];
    this.selectedAgent = loaded.value.agent ?? this.selectedAgent;
    this.selectedModel = loaded.value.model ?? this.selectedModel;
    await this.inferSelectedProvider();
    this.resetHost();
    return {
      ok: true,
      session: sessionSummary(loaded.value, true),
    };
  }

  public async newSession(): Promise<{
    readonly ok: true;
    readonly session: SessionSummary;
  } | RuntimeActionError> {
    const created = await this.sessionStore.create({
      cwd: workspaceCwd(),
      ...(this.selectedAgent ? { agent: this.selectedAgent } : {}),
      ...(this.selectedModel ? { model: this.selectedModel } : {}),
    });
    if (!created.ok) return runtimeError(created.error);
    await this.setActiveSessionId(created.value.id);
    this.initialMessages = [];
    this.lastTodos = [];
    this.resetHost();
    return { ok: true, session: sessionSummary(created.value, true) };
  }

  public async renameSession(id: string, title: string): Promise<{
    readonly ok: true;
    readonly session: SessionSummary;
  } | RuntimeActionError> {
    const renamed = await this.sessionStore.rename(id, title);
    if (!renamed.ok) return runtimeError(renamed.error);
    return { ok: true, session: sessionSummary(renamed.value, renamed.value.id === this.activeSessionId) };
  }

  public async promptRenameSession(id: string, currentTitle: string | null): Promise<{
    readonly ok: true;
    readonly session?: SessionSummary;
    readonly sessionRenameCancelled?: boolean;
  } | RuntimeActionError> {
    const title = await vscode.window.showInputBox({
      title: 'Atlas: Rename Session',
      value: currentTitle ?? '',
      prompt: 'Give this Atlas session a short title.',
      ignoreFocusOut: true,
    });
    if (title === undefined) return { ok: true, sessionRenameCancelled: true };
    return this.renameSession(id, title.trim());
  }

  public async deleteSession(id: string): Promise<{
    readonly ok: true;
    readonly deleted: string;
    readonly activeSessionId: string | null;
  } | RuntimeActionError> {
    const removed = await this.sessionStore.remove(id);
    if (!removed.ok) return runtimeError(removed.error);
    if (id === this.activeSessionId) {
      await this.setActiveSessionId(null);
      this.initialMessages = [];
      this.lastTodos = [];
      this.resetHost();
    }
    return { ok: true, deleted: id, activeSessionId: this.activeSessionId };
  }

  public async getTaskStatus(): Promise<TaskStatusResult> {
    const task = await loadActiveTask(workspaceCwd());
    if (!task.ok) throw new Error(task.error.message);
    return {
      ok: true,
      task: task.value ? taskSummary(task.value) : null,
    };
  }

  public async getTodos(): Promise<TodoStatusResult> {
    if (!this.hostPromise) return { ok: true, todos: this.lastTodos };
    const hostResult = await this.hostPromise;
    if (!hostResult.ok) return { ok: true, todos: this.lastTodos };
    this.lastTodos = hostResult.value.todos;
    return { ok: true, todos: this.lastTodos };
  }

  public async promptSecret(key: PromptSecretKey): Promise<{
    readonly ok: true;
    readonly secret: PromptSecretKey;
    readonly configured: boolean;
    readonly label: string;
  } | RuntimeActionError> {
    const stored = await promptAndStoreSecret(this.context, key);
    if (!stored.ok) return runtimeError(stored.error);
    this.resetHost();
    return {
      ok: true,
      secret: key,
      configured: stored.value.configured,
      label: promptSecretLabel(key),
    };
  }

  public async clearSecret(key: PromptSecretKey): Promise<{
    readonly ok: true;
    readonly secret: PromptSecretKey;
    readonly configured: boolean;
    readonly label: string;
  } | RuntimeActionError> {
    const cleared = await clearStoredSecret(this.context, key);
    if (!cleared.ok) return runtimeError(cleared.error);
    this.resetHost();
    return {
      ok: true,
      secret: key,
      configured: cleared.value.configured,
      label: promptSecretLabel(key),
    };
  }

  public async storeSecret(key: PromptSecretKey, value: string): Promise<{
    readonly ok: true;
    readonly secret: PromptSecretKey;
    readonly configured: boolean;
    readonly label: string;
  } | RuntimeActionError> {
    const stored = await storeSecretValue(this.context, key, value);
    if (!stored.ok) return runtimeError(stored.error);
    this.resetHost();
    return {
      ok: true,
      secret: key,
      configured: stored.value.configured,
      label: promptSecretLabel(key),
    };
  }

  public async updateSettings(update: SafeConfigUpdate): Promise<{
    readonly ok: true;
    readonly configPath: string;
    readonly settingsUpdated: boolean;
    readonly update: SafeConfigUpdate;
  } | RuntimeActionError> {
    const saved = await updateVsCodeConfig(this.context, update);
    if (!saved.ok) return runtimeError(saved.error);
    if (update.defaultProvider !== undefined) this.selectedProvider = defaultProviderKind(update.defaultProvider);
    if (update.defaultModel !== undefined) this.selectedModel = update.defaultModel;
    this.resetHost();
    return { ok: true, configPath: saved.value.path, settingsUpdated: true, update };
  }

  public cancelTurn(): { readonly ok: true; readonly cancelled: boolean } {
    if (!this.currentAbortController) return { ok: true, cancelled: false };
    this.approvals.cancelAll('Atlas turn cancelled from the VS Code sidebar.');
    this.currentAbortController.abort();
    return { ok: true, cancelled: true };
  }

  public setMode(mode: 'plan' | 'build' | 'autopilot'): { readonly ok: true; readonly mode: string } {
    this.currentMode = mode;
    this.output.appendLine(`[atlas] mode → ${mode}`);
    return { ok: true, mode };
  }

  public async setThinking(level: ThinkingLevel): Promise<{ readonly ok: true; readonly level: ThinkingLevel } | RuntimeActionError> {
    const configResult = await loadVsCodeConfig(this.context);
    if (!configResult.ok) return runtimeError(configResult.error);
    const catalog = await loadVsCodeModelCatalog(configResult.value);
    const activeModel = this.selectedModel ?? configResult.value.defaultModel;
    const activeProvider = this.selectedProvider ?? defaultProviderKind(configResult.value.defaultProvider);
    const allowed = allowedThinkingForSelection(activeModel, activeProvider, catalog);
    if (!allowed.includes(level)) {
      return runtimeError(atlasError(
        'CONFIG_INVALID',
        `${activeModel} does not support thinking=${level}. Allowed: ${allowed.join('|')}`,
      ));
    }
    this.selectedThinking = level;
    this.output.appendLine(`[atlas] thinking → ${level}`);
    return { ok: true, level };
  }

  public setLearnEnabled(enabled: boolean): void {
    this.learnEnabled = enabled;
  }

  public async runTurn(
    prompt: string,
    attachments: ReadonlyArray<{ type: 'file'; path: string; content: string } | { type: 'image'; path: string; base64: string; mediaType: string }>,
    handlers: RunTurnHandlers,
  ): Promise<void> {
    if (this.currentAbortController) {
      await handlers.onError(atlasError('TOOL_EXECUTION_FAILED', 'Atlas is already running a turn in this VS Code window.'));
      return;
    }
    const hostResult = await this.getHost();
    if (!hostResult.ok) {
      await handlers.onError(hostResult.error);
      return;
    }
    const abortController = new AbortController();
    this.currentAbortController = abortController;

    this.output.appendLine(
      `[atlas] ${hostResult.value.agentName} / ${hostResult.value.providerName} / ${hostResult.value.model}`,
    );

    const content: ContentBlock[] = [{ type: 'text', text: prompt }];
    for (const att of attachments) {
      if (att.type === 'image') {
        content.push({ type: 'image', base64: att.base64, mediaType: att.mediaType });
      } else {
        content.push({
          type: 'text',
          text: `\n\n--- File: ${att.path} ---\n${att.content}\n---\n`,
        });
      }
    }

    let turnRounds = 0;
    let turnToolErrors = 0;

    try {
      for await (const event of hostResult.value.runTurn(content, { signal: abortController.signal })) {
        if (event.type === 'tool_call_done' && event.outcome.type === 'error') {
          turnToolErrors += 1;
        }
        if (event.type === 'done') {
          turnRounds = event.rounds;
        }
        await handlers.onEvent(event);
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        await handlers.onError(atlasError('TOOL_CANCELLED', 'Atlas turn cancelled from the VS Code sidebar.'));
      } else {
        await handlers.onError(atlasError(
          'INTERNAL',
          error instanceof Error ? error.message : 'Atlas turn failed in the VS Code host.',
          { cause: error },
        ));
      }
    } finally {
      this.currentAbortController = null;
      this.lastTodos = hostResult.value.todos;
      await this.persistHostSession(hostResult.value);

      if (this.learnEnabled && shouldOfferLearn(turnRounds, turnToolErrors, prompt)) {
        const reason = describeLearnReason(turnRounds, turnToolErrors, prompt);
        void this.learnBroker.runReflection(
          hostResult.value.provider,
          hostResult.value.model,
          hostResult.value.history,
          reason,
          false,
        );
      }
    }
  }

  public getHost(): Promise<Result<AtlasSessionHost, AtlasError>> {
    const toolHost = vscode as unknown as VsCodeToolHost;
    this.hostPromise ??= (async (): Promise<Result<AtlasSessionHost, AtlasError>> => {
      const configResult = await loadVsCodeConfig(this.context);
      if (!configResult.ok) return err(configResult.error);
      const config = configResult.value;
      const providerKind = this.selectedProvider ?? defaultProviderKind(config.defaultProvider);
      const providerResult = await createProviderForSelection(this.context, config, providerKind);
      if (!providerResult.ok) return err(providerResult.error);
      const { createAtlasSessionHost } = await import('./session-host.js');
      return createAtlasSessionHost({
        cwd: workspaceCwd(),
        config,
        provider: providerResult.value,
        model: this.selectedModel ?? config.defaultModel,
        thinking: this.selectedThinking,
        ...(this.selectedAgent ? { agentName: this.selectedAgent } : {}),
        initialMessages: this.initialMessages,
        initialTodos: this.lastTodos,
        tools: createVsCodeToolRegistry(toolHost),
        approvalPolicy: createVsCodeApprovalPolicy(toolHost, this.approvals),
        clarifyAsk: createVsCodeClarifyAsk(this.clarifyBroker),
      });
    })();
    return this.hostPromise;
  }

  private resetHost(): void {
    this.hostPromise = null;
  }

  private async inferSelectedProvider(): Promise<void> {
    if (!this.selectedModel) return;
    const configResult = await loadVsCodeConfig(this.context);
    if (!configResult.ok) return;
    const catalog = await loadVsCodeModelCatalog(configResult.value);
    const match = catalog.find((model) => model.id === this.selectedModel);
    this.selectedProvider = match?.provider ?? defaultProviderKind(configResult.value.defaultProvider);
  }

  private async setActiveSessionId(id: string | null): Promise<void> {
    this.activeSessionId = id;
    await this.context.globalState.update(ACTIVE_SESSION_KEY, id);
  }

  private async ensureActiveSession(host: AtlasSessionHost): Promise<Result<SessionRecord, AtlasError>> {
    if (this.activeSessionId) {
      const loaded = await this.sessionStore.load(this.activeSessionId);
      if (loaded.ok) return ok(loaded.value);
    }
    const created = await this.sessionStore.create({
      cwd: workspaceCwd(),
      agent: host.agentName,
      model: host.model,
    });
    if (!created.ok) return err(created.error);
    await this.setActiveSessionId(created.value.id);
    return ok(created.value);
  }

  private async persistHostSession(host: AtlasSessionHost): Promise<void> {
    const session = await this.ensureActiveSession(host);
    if (!session.ok) {
      this.output.appendLine(`[session error] ${session.error.message}`);
      return;
    }
    session.value.agent = host.agentName;
    session.value.model = host.model;
    session.value.messages = [...host.history];
    const wrote = await this.sessionStore.write(session.value);
    if (!wrote.ok) this.output.appendLine(`[session error] ${wrote.error.message}`);
  }
}

const defaultProviderKind = (provider: AtlasConfig['defaultProvider']): ModelProviderKind => provider;

const normalizeThinking = (
  requested: ThinkingLevel,
  allowed: readonly ThinkingLevel[],
): ThinkingLevel => {
  if (allowed.includes(requested)) return requested;
  return allowed.includes('off') ? 'off' : allowed[0] ?? 'off';
};

const isSwitchableAgent = (agent: Agent): boolean =>
  agent.name === 'atlas' || !isFrameworkAgent(agent);

const compareAgentSummaries = (a: AgentSummary, b: AgentSummary): number => {
  if (a.switchable !== b.switchable) return a.switchable ? -1 : 1;
  if (a.active !== b.active) return a.active ? -1 : 1;
  return a.name.localeCompare(b.name);
};

const createProviderForSelection = async (
  context: vscode.ExtensionContext,
  config: AtlasConfig,
  provider: ModelProviderKind,
): Promise<Result<Provider, AtlasError>> => {
  switch (provider) {
    case 'openrouter': {
      const cfg = config.providers.openrouter;
      if (!cfg.apiKey) {
        return err(atlasError('PROVIDER_AUTH_FAILED', 'OpenRouter API key missing for selected model.'));
      }
      return ok(createOpenRouterProvider({
        apiKey: cfg.apiKey,
        ...(cfg.apiKeys.length > 0 ? { fallbackKeys: cfg.apiKeys } : {}),
        baseUrl: cfg.baseUrl,
        ...(cfg.referer !== undefined ? { referer: cfg.referer } : {}),
        title: cfg.title,
      }));
    }
    case 'anthropic': {
      const cfg = config.providers.anthropic;
      if (cfg.apiKey) {
        return ok(createAnthropicProvider({
          auth: {
            kind: 'apiKey',
            apiKey: cfg.apiKey,
            ...(cfg.apiKeys.length > 0 ? { fallbackKeys: cfg.apiKeys } : {}),
          },
          baseUrl: cfg.baseUrl,
        }));
      }
      if (!cfg.useClaudeCodeOauth) {
        return err(atlasError('PROVIDER_AUTH_FAILED', 'Anthropic API key or Claude Code OAuth is required for selected model.'));
      }
      const creds = await loadClaudeCodeCredentials(
        cfg.claudeCodeCredentialsPath ? { path: cfg.claudeCodeCredentialsPath } : {},
      );
      if (!creds.ok) return err(creds.error);
      return ok(createAnthropicProvider({
        auth: { kind: 'oauth', accessToken: creds.value.accessToken },
        baseUrl: cfg.baseUrl,
      }));
    }
    case 'local': {
      const cfg = config.providers.local;
      return ok(createLocalProvider({
        baseUrl: cfg.baseUrl,
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        ...(Object.keys(cfg.headers).length > 0 ? { headers: cfg.headers } : {}),
        toolMode: cfg.toolMode,
        requestTimeoutMs: cfg.requestTimeoutMs,
      }));
    }
    case 'opencode-zen': {
      const cfg = config.providers.opencode.zen;
      if (!cfg.apiKey) return err(atlasError('PROVIDER_AUTH_FAILED', 'OpenCode Zen API key missing for selected model.'));
      return ok(createOpenCodeProvider({ plan: 'zen', apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }));
    }
    case 'opencode-go': {
      const cfg = config.providers.opencode.go;
      if (!cfg.apiKey) return err(atlasError('PROVIDER_AUTH_FAILED', 'OpenCode Go API key missing for selected model.'));
      return ok(createOpenCodeProvider({ plan: 'go', apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }));
    }
    case 'openai-codex': {
      if (config.providers.openai.authMode !== 'oauth' && config.providers.openai.apiKey) {
        return ok(createOpenCodeProvider({
          plan: 'zen',
          apiKey: config.providers.openai.apiKey,
          baseUrl: config.providers.openai.apiBaseUrl,
          providerName: 'openai',
        }));
      }
      if (config.providers.openai.authMode === 'apiKey') {
        return err(atlasError('PROVIDER_AUTH_FAILED', 'OpenAI API key missing for selected model.'));
      }
      const cfg = config.providers.openai.codex;
      if (!cfg.accessToken) {
        return err(atlasError('PROVIDER_AUTH_FAILED', 'ChatGPT / Codex OAuth is required for selected model.'));
      }
      let snapshot: CodexTokenSnapshot = {
        accessToken: cfg.accessToken,
        ...(cfg.refreshToken !== undefined ? { refreshToken: cfg.refreshToken } : {}),
        ...(cfg.idToken !== undefined ? { idToken: cfg.idToken } : {}),
        ...(cfg.accountId !== undefined ? { accountId: cfg.accountId } : {}),
        ...(typeof cfg.expiresAt === 'number' ? { expiresAt: cfg.expiresAt } : {}),
      };
      return ok(createCodexProvider({
        baseUrl: config.providers.openai.baseUrl,
        tokens: {
          read: () => snapshot,
          write: async (next) => {
            snapshot = next;
            await storeCodexTokens(context, next);
            const latest = await loadVsCodeConfig(context);
            if (!latest.ok) return;
            const merged: AtlasConfig = {
              ...latest.value,
              providers: {
                ...latest.value.providers,
                openai: {
                  ...latest.value.providers.openai,
                  codex: next,
                },
              },
            };
            await saveVsCodeConfig(context, merged);
          },
        },
      }));
    }
  }
};

const mcpRowsFromConfig = (servers: readonly McpServerConfig[]): readonly McpServerSummary[] => {
  const rows = new Map<string, McpServerSummary>();
  for (const server of servers) rows.set(server.name, configuredMcpRow(server));

  for (const builtin of DEFAULT_BUILTIN_MCP_SERVERS) {
    if (!rows.has(builtin.name)) {
      rows.set(builtin.name, {
        name: builtin.name,
        transport: builtin.transport,
        enabled: builtin.enabled,
        configured: false,
        source: 'builtin',
        status: 'not-configured',
        tools: 0,
        summary: 'Built-in MCP available from the Atlas default seed.',
        command: builtin.command ?? null,
        args: [...builtin.args],
        url: null,
        docs: null,
        error: null,
      });
    }
  }

  for (const suggestion of MCP_SUGGESTIONS) {
    if (!rows.has(suggestion.name)) {
      rows.set(suggestion.name, {
        name: suggestion.name,
        transport: suggestion.transport,
        enabled: false,
        configured: false,
        source: 'catalog',
        status: 'not-configured',
        tools: 0,
        summary: `${suggestion.pricing} - ${suggestion.summary}`,
        command: suggestion.transport === 'stdio' ? suggestion.command : null,
        args: suggestion.transport === 'stdio' ? [...suggestion.args] : [],
        url: suggestion.transport === 'http' ? suggestion.url : null,
        docs: suggestion.docs,
        error: null,
      });
    }
  }

  return [...rows.values()].sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
};

const configuredMcpRow = (server: McpServerConfig): McpServerSummary => {
  const suggestion = MCP_SUGGESTIONS.find((item) => item.name === server.name);
  const builtin = DEFAULT_BUILTIN_MCP_SERVERS.some((item) => item.name === server.name);
  const missingDetail = server.transport === 'http' && !server.url
    ? 'missing URL'
    : server.transport === 'stdio' && !server.command
      ? 'missing command'
      : null;
  return {
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    configured: true,
    source: builtin ? 'builtin' : 'configured',
    status: missingDetail ? 'failed' : server.enabled ? 'not-started' : 'disabled',
    tools: 0,
    summary: mcpServerSummary(server),
    command: server.command ?? null,
    args: [...server.args],
    url: server.url ?? null,
    docs: suggestion?.docs ?? null,
    error: missingDetail,
  };
};

const mcpServerSummary = (server: McpServerConfig): string => {
  if (server.transport === 'http') return server.url ?? 'HTTP server has no URL configured';
  return [server.command ?? 'stdio server has no command configured', ...server.args].join(' ');
};

const mcpServerConfigFromCatalog = (name: string): McpServerConfig | null => {
  const builtin = DEFAULT_BUILTIN_MCP_SERVERS.find((server) => server.name === name);
  if (builtin) {
    return {
      name: builtin.name,
      transport: builtin.transport,
      command: builtin.command,
      args: [...builtin.args],
      env: { ...builtin.env },
      headers: { ...builtin.headers },
      enabled: builtin.enabled,
    };
  }

  const suggestion = MCP_SUGGESTIONS.find((server) => server.name === name);
  if (!suggestion) return null;
  const canEnableImmediately = suggestion.env.every((envVar) => !envVar.required);
  if (suggestion.transport === 'stdio') {
    return {
      name: suggestion.name,
      transport: 'stdio',
      command: suggestion.command,
      args: [...suggestion.args],
      env: {},
      headers: {},
      enabled: canEnableImmediately,
    };
  }
  return {
    name: suggestion.name,
    transport: 'http',
    args: [],
    env: {},
    url: suggestion.url,
    headers: {},
    enabled: canEnableImmediately,
  };
};

const sessionSummary = (session: SessionRecord, active: boolean): SessionSummary => ({
  id: session.id,
  updatedAt: session.updatedAt,
  title: session.title ?? null,
  active,
});

const taskSummary = (task: TaskState): TaskSummary => ({
  id: task.id,
  title: task.title,
  phase: task.phase,
  note: task.note ?? null,
  updatedAt: task.updatedAt,
  contextDocPath: task.contextDocPath ?? null,
  planDocPath: task.planDocPath ?? null,
});

const runtimeError = (error: AtlasError): RuntimeActionError => ({
  ok: false,
  error: { message: error.message, code: error.code },
});

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
    case 'tool_call_done':
      return {
        requestId,
        kind: 'stream-event',
        event: { type: 'tool_result', call: event.call, outcome: bridgeToolOutcome(event.outcome) },
      };
    case 'turn_end':
      return { requestId, kind: 'stream-event', event: { type: 'turn_end' } };
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
      return null;
  }
};

const bridgeToolOutcome = (
  outcome: Extract<LoopEvent, { readonly type: 'tool_call_done' }>['outcome'],
): Extract<BridgeResponse, { readonly kind: 'stream-event' }>['event'] extends infer Event
  ? Event extends { readonly type: 'tool_result'; readonly outcome: infer Outcome } ? Outcome : never
  : never => {
  if (outcome.type === 'ok') return outcome;
  return {
    type: 'error',
    error: {
      message: outcome.error.message,
      code: outcome.error.code,
    },
  };
};


const mimeTypeFromExt = (ext: string): string => {
  switch (ext.toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
};
