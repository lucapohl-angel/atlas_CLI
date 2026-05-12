import type { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@vscode/codicons/dist/codicon.css';
import atlasLogoUrl from './atlas-logo.png';
import atlasMarkUrl from './atlas-mark.png';
import octopusIconUrl from './octopus-icon.svg';
import './styles.css';

type VsCodeApi = {
  postMessage(message: unknown): void;
};

type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
};

type ApprovalAction = 'allow' | 'deny';

type InlineApprovalRequest = {
  readonly id: string;
  readonly tool: string;
  readonly preview: string;
  readonly createdAt: string;
};

type TokenUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
};

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh';
type ModelProviderKind = 'openrouter' | 'anthropic' | 'openai-codex' | 'local' | 'opencode-zen' | 'opencode-go';
type ModelProviderFilter = ModelProviderKind | 'all' | 'opencode';
type DefaultProvider = 'openrouter' | 'anthropic' | 'openai-codex' | 'local' | 'opencode-zen' | 'opencode-go';
type ShipAutoResolve = 'abort' | 'ours' | 'theirs' | 'ai';
type OpenAIAuthMode = 'auto' | 'apiKey' | 'oauth';
type AuthProviderId = 'openrouter' | 'anthropic' | 'openai' | 'opencode-zen' | 'opencode-go' | 'local' | 'github';

type ToolOutcome =
  | { readonly type: 'ok'; readonly summary: string }
  | { readonly type: 'error'; readonly error: { readonly message: string; readonly code?: string } };

type ClarifyRequestEvent = {
  readonly type: 'clarify_request';
  readonly clarify: {
    readonly id: string;
    readonly question: string;
    readonly choices?: readonly string[];
    readonly allowFreeform: boolean;
  };
};

type ClarifyResolvedEvent = {
  readonly type: 'clarify_resolved';
  readonly clarifyId: string;
  readonly answer: string;
};

type LearnReflectingEvent = {
  readonly type: 'learn_reflecting';
  readonly reason: string;
};

type LearnReviewEvent = {
  readonly type: 'learn_review';
  readonly draft: {
    readonly name: string;
    readonly description: string;
    readonly triggers: readonly string[];
    readonly body: string;
  };
  readonly reason: string;
};

type LearnNothingEvent = {
  readonly type: 'learn_nothing';
  readonly reason: string;
  readonly force: boolean;
};

type LearnErrorEvent = {
  readonly type: 'learn_error';
  readonly error: string;
};

type LearnSavedEvent = {
  readonly type: 'learn_saved';
  readonly name: string;
  readonly description: string;
};

type BridgeStreamEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'tool_call'; readonly call: ToolCall }
  | { readonly type: 'tool_result'; readonly call: ToolCall; readonly outcome: ToolOutcome }
  | { readonly type: 'turn_end' }
  | { readonly type: 'approval_request'; readonly approval: InlineApprovalRequest }
  | { readonly type: 'approval_resolved'; readonly approvalId: string; readonly action: ApprovalAction }
  | { readonly type: 'done'; readonly finishReason: string | null; readonly usage?: TokenUsage }
  | { readonly type: 'error'; readonly error: { readonly message: string; readonly code?: string } }
  | ClarifyRequestEvent
  | ClarifyResolvedEvent
  | LearnReflectingEvent
  | LearnReviewEvent
  | LearnNothingEvent
  | LearnErrorEvent
  | LearnSavedEvent;

type BridgeMessage =
  | { readonly requestId: string; readonly kind: 'response'; readonly result: unknown }
  | { readonly requestId: string; readonly kind: 'error'; readonly error: { readonly message: string; readonly code?: string } }
  | { readonly requestId: string; readonly kind: 'stream-event'; readonly event: BridgeStreamEvent };

type AtlasStatus = {
  readonly ok: boolean;
  readonly cwd?: string;
  readonly agentName?: string;
  readonly providerName?: string;
  readonly model?: string;
  readonly mode?: 'plan' | 'build' | 'autopilot';
  readonly thinking?: ThinkingLevel;
  readonly error?: { readonly message: string; readonly code?: string };
};

type SettingsProviderSummary = {
  readonly configured: boolean;
  readonly baseUrl: string;
  readonly fallbackKeys: number;
  readonly customModels: number;
};

type SettingsSummary = {
  readonly ok: true;
  readonly configPath: string;
  readonly cwd: string;
  readonly defaultProvider: DefaultProvider;
  readonly defaultModel: string;
  readonly routerModel: string | null;
  readonly fallbackModels: number;
  readonly atlasMode: 'full' | 'smart';
  readonly vscodePowerMode: 'lite' | 'hybrid' | 'full';
  readonly providers: {
    readonly openrouter: SettingsProviderSummary;
    readonly anthropic: SettingsProviderSummary & { readonly oauthEnabled: boolean };
    readonly openaiCodex: {
      readonly configured: boolean;
      readonly baseUrl: string;
      readonly accountId: string | null;
      readonly expiresAt: number | null;
      readonly apiKeyConfigured: boolean;
      readonly oauthConfigured: boolean;
      readonly authMode: OpenAIAuthMode;
    };
    readonly opencodeZen: SettingsProviderSummary;
    readonly opencodeGo: SettingsProviderSummary;
    readonly local: SettingsProviderSummary & { readonly autoDetect: boolean; readonly toolMode: string; readonly requestTimeoutMs: number; readonly apiKeyConfigured: boolean };
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
  readonly ship: { readonly autoResolve: ShipAutoResolve; readonly promptOnConflict: boolean };
  readonly directories: { readonly agents: string; readonly skills: string };
  readonly commands: { readonly vscodeSetup: string };
  readonly tools: readonly { readonly name: string; readonly description: string; readonly approval: 'auto' | 'ask' | 'never' }[];
};

type SettingsSummaryError = {
  readonly ok: false;
  readonly configPath: string;
  readonly cwd: string;
  readonly error: { readonly message: string; readonly code: string };
};

type SettingsSummaryResult = SettingsSummary | SettingsSummaryError;

type PromptSecretKey =
  | 'openrouter.apiKey'
  | 'anthropic.apiKey'
  | 'openai.apiKey'
  | 'opencode.zen.apiKey'
  | 'opencode.go.apiKey'
  | 'local.apiKey'
  | 'github.token';

type SafeSettingsUpdate = {
  readonly defaultProvider?: DefaultProvider;
  readonly defaultModel?: string;
  readonly routerModel?: string | null;
  readonly atlasMode?: 'full' | 'smart';
  readonly vscodePowerMode?: 'lite' | 'hybrid' | 'full';
  readonly localBaseUrl?: string;
  readonly localAutoDetect?: boolean;
  readonly localToolMode?: 'lite' | 'hybrid' | 'full';
  readonly localRequestTimeoutMs?: number;
  readonly anthropicUseClaudeCodeOauth?: boolean;
  readonly openaiAuthMode?: OpenAIAuthMode;
  readonly compactionEnabled?: boolean;
  readonly compactionModel?: string | null;
  readonly compactionThreshold?: number;
  readonly compactionContextTokens?: number;
  readonly shipAutoResolve?: ShipAutoResolve;
  readonly promptOnConflict?: boolean;
  readonly guardrailsEnabled?: boolean;
  readonly guardrailDangerousCommand?: boolean;
  readonly guardrailPathSafety?: boolean;
  readonly guardrailSecretRedaction?: boolean;
  readonly guardrailPromptInjectionDetector?: boolean;
  readonly guardrailDiscoverGuardrails?: boolean;
  readonly guardrailProgressTracker?: boolean;
};

type ModelSummary = {
  readonly id: string;
  readonly label: string;
  readonly provider: ModelProviderKind;
  readonly providerLabel: string;
  readonly contextWindow: number | null;
  readonly promptCacheLabel: string;
  readonly thinking: readonly ThinkingLevel[];
  readonly supportsVision: boolean;
  readonly active: boolean;
  readonly configuredDefault: boolean;
  readonly fallback: boolean;
  readonly custom: boolean;
  readonly selectable: boolean;
  readonly note: string | null;
};

type ModelSummaryResult = {
  readonly ok: true;
  readonly activeModel: string;
  readonly activeProvider: ModelProviderKind;
  readonly activeThinking: ThinkingLevel;
  readonly models: readonly ModelSummary[];
  readonly diagnostics?: readonly {
    readonly provider: ModelProviderKind;
    readonly providerLabel: string;
    readonly status: 'loaded' | 'skipped' | 'fallback' | 'error';
    readonly count: number;
    readonly message: string;
  }[];
};

type AgentSummary = {
  readonly name: string;
  readonly role: string;
  readonly description: string;
  readonly kind: 'framework' | 'user';
  readonly active: boolean;
  readonly switchable: boolean;
};

type AgentSummaryResult = {
  readonly ok: true;
  readonly activeAgent: string;
  readonly switchableCount: number;
  readonly agents: readonly AgentSummary[];
};

type McpServerSummary = {
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
};

type McpStatusResult = {
  readonly ok: true;
  readonly servers: readonly McpServerSummary[];
  readonly configured: number;
  readonly enabled: number;
  readonly active: number;
  readonly note: string;
};

type McpServerDraft = {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly enabled: boolean;
};

type SessionSummary = {
  readonly id: string;
  readonly updatedAt: string;
  readonly title: string | null;
  readonly active: boolean;
};

type SessionListResult = {
  readonly ok: true;
  readonly sessions: readonly SessionSummary[];
  readonly activeSessionId: string | null;
};

type TaskSummary = {
  readonly id: string;
  readonly title: string;
  readonly phase: 'idle' | 'discover' | 'plan' | 'execute' | 'verify' | 'ship';
  readonly note: string | null;
  readonly updatedAt: string;
  readonly contextDocPath: string | null;
  readonly planDocPath: string | null;
};

type TaskStatusResult = {
  readonly ok: true;
  readonly task: TaskSummary | null;
};

type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

type TodoItem = {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
};

type TodoStatusResult = {
  readonly ok: true;
  readonly todos: readonly TodoItem[];
};

type RuntimeActionResult =
  | { readonly ok: true; readonly [key: string]: unknown }
  | { readonly ok: false; readonly error: { readonly message: string; readonly code: string } };

type OpenConfigResult = {
  readonly ok: true;
  readonly path: string;
};

type OpenFileResult = {
  readonly ok: true;
  readonly path: string;
  readonly absolutePath: string;
  readonly line: number | null;
};

type FileReference = {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
};

type SlashCommand = {
  readonly name: string;
  readonly summary: string;
  readonly group: 'Chat' | 'Routing' | 'Runtime' | 'Workflow' | 'State';
};

type SettingsDetail = {
  readonly title: string;
  readonly description: string;
  readonly rows?: readonly { readonly label: string; readonly value: string }[];
  readonly action?: { readonly label: string; readonly run: () => void };
};

type GuardrailUpdateKey =
  | 'guardrailDangerousCommand'
  | 'guardrailPathSafety'
  | 'guardrailSecretRedaction'
  | 'guardrailPromptInjectionDetector'
  | 'guardrailDiscoverGuardrails'
  | 'guardrailProgressTracker';

type BridgeRequestKind =
  | 'getStatus'
  | 'getSettings'
  | 'openConfig'
  | 'openFile'
  | 'getModels'
  | 'selectModel'
  | 'getAgents'
  | 'selectAgent'
  | 'getMcpStatus'
  | 'getSessions'
  | 'resumeSession'
  | 'newSession'
  | 'renameSession'
  | 'deleteSession'
  | 'promptRenameSession'
  | 'getTaskStatus'
  | 'getTodos'
  | 'resolveApproval'
  | 'promptSecret'
  | 'storeSecret'
  | 'clearSecret'
  | 'signInCodex'
  | 'updateSettings'
  | 'setMcpEnabled'
  | 'addMcpServer'
  | 'upsertMcpServer'
  | 'removeMcpServer'
  | 'setMode'
  | 'setThinking'
  | 'cancelTurn'
  | 'runTurn'
  | 'attachFile'
  | 'resolveClarify'
  | 'resolveLearn'
  | 'runLearnReflection'
  | 'setLearnEnabled'
  | 'ping';

type ActiveView = 'chat' | 'settings' | 'mcp' | 'sessions' | 'task';
type TopActionId = 'new' | 'history' | 'mcp' | 'agents' | 'settings';

type TopAction = {
  readonly id: TopActionId;
  readonly label: string;
  readonly icon: string;
};

type SelectorName = 'model' | 'agent' | 'thinking' | 'attach';

type QuickOption = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
};

type ChatTool = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  readonly state: 'running' | 'ok' | 'error';
  readonly summary?: string;
};

type ChatMessage = {
  readonly id: string;
  readonly requestId?: string;
  readonly role: 'user' | 'assistant' | 'system' | 'error';
  readonly content: string;
  readonly rawContent?: string;
  readonly thinking?: string;
  readonly tools?: readonly ChatTool[];
  readonly usage?: TokenUsage;
  readonly pending?: boolean;
};

declare global {
  function acquireVsCodeApi(): VsCodeApi;
}

const vscode = getVsCodeApi();
const topActions: readonly TopAction[] = [
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'new', label: 'New Session', icon: 'add' },
];

const welcomeMessage: ChatMessage = {
  id: 'welcome',
  role: 'system',
  content: 'ATLAS.OS is ready in this workspace.',
};

const slashCommands: readonly SlashCommand[] = [
  { name: 'help', summary: 'show the command map', group: 'Chat' },
  { name: 'clear', summary: 'clear the current conversation', group: 'Chat' },
  { name: 'history', summary: 'print message history', group: 'Chat' },
  { name: 'model', summary: 'open or stage model switching', group: 'Routing' },
  { name: 'models', summary: 'open the model picker', group: 'Routing' },
  { name: 'restart', summary: 'refresh live model catalog', group: 'Runtime' },
  { name: 'agent', summary: 'switch agent or bind model', group: 'Routing' },
  { name: 'agents', summary: 'list installed switchable agents', group: 'Routing' },
  { name: 'mode', summary: 'set plan, build, or autopilot', group: 'Runtime' },
  { name: 'thinking', summary: 'set model-aware reasoning effort', group: 'Runtime' },
  { name: 'config', summary: 'open provider, MCP, auth, and ship settings', group: 'Runtime' },
  { name: 'mcps', summary: 'list, add, enable, disable MCP servers', group: 'Runtime' },
  { name: 'sessions', summary: 'list, resume, rename, or delete sessions', group: 'State' },
  { name: 'resume', summary: 'resume a saved session by id', group: 'State' },
  { name: 'compact', summary: 'auto-compaction controls', group: 'Runtime' },
  { name: 'learn', summary: 'manage the self-improvement loop', group: 'Workflow' },
  { name: 'skills', summary: 'list, enable, or disable skills', group: 'Workflow' },
  { name: 'next', summary: 'ask Atlas for the next workflow step', group: 'Workflow' },
  { name: 'onboard', summary: 'start brownfield onboarding', group: 'Workflow' },
  { name: 'tools', summary: 'browse built-in tools', group: 'Runtime' },
  { name: 'status', summary: 'show workflow phase and active task', group: 'Workflow' },
  { name: 'back', summary: 'rewind to an earlier workflow phase', group: 'Workflow' },
  { name: 'skip', summary: 'jump forward in the workflow', group: 'Workflow' },
  { name: 'abort', summary: 'abandon the active task', group: 'Workflow' },
  { name: 'quit', summary: 'leave Atlas', group: 'Chat' },
  { name: 'exit', summary: 'leave Atlas', group: 'Chat' },
];

const slashCommandGroups: readonly SlashCommand['group'][] = ['Chat', 'Routing', 'Runtime', 'Workflow', 'State'];

function App(): ReactElement {
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<readonly ChatMessage[]>([welcomeMessage]);
  const [status, setStatus] = useState<AtlasStatus>({ ok: false });
  const [settings, setSettings] = useState<SettingsSummaryResult | null>(null);
  const [models, setModels] = useState<ModelSummaryResult | null>(null);
  const [agents, setAgents] = useState<AgentSummaryResult | null>(null);
  const [mcpStatus, setMcpStatus] = useState<McpStatusResult | null>(null);
  const [sessions, setSessions] = useState<SessionListResult | null>(null);
  const [taskStatus, setTaskStatus] = useState<TaskStatusResult | null>(null);
  const [todos, setTodos] = useState<TodoStatusResult | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<readonly InlineApprovalRequest[]>([]);
  const [activeView, setActiveView] = useState<ActiveView>('chat');
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [runningRequestId, setRunningRequestId] = useState<string | null>(null);
  const [openSelector, setOpenSelector] = useState<SelectorName | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [slashCursor, setSlashCursor] = useState(0);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectorRailRef = useRef<HTMLDivElement | null>(null);
  const pendingRequestKindsRef = useRef<Map<string, BridgeRequestKind>>(new Map());
  const [showSessionPanel, setShowSessionPanel] = useState(false);
  const [sessionId] = useState(() => {
    const seg = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
    return `${seg()}${seg()}-${seg()}-4${seg().slice(0, 3)}-${seg()}-${seg()}${seg()}${seg()}`;
  });

  const [clarifyRequest, setClarifyRequest] = useState<{
    readonly id: string;
    readonly question: string;
    readonly choices?: readonly string[];
    readonly allowFreeform: boolean;
  } | null>(null);

  const [learnState, setLearnState] = useState<
    | { readonly stage: 'reflecting'; readonly reason: string }
    | { readonly stage: 'review'; readonly draft: { readonly name: string; readonly description: string; readonly triggers: readonly string[]; readonly body: string }; readonly reason: string }
    | { readonly stage: 'change'; readonly draft: { readonly name: string; readonly description: string; readonly triggers: readonly string[]; readonly body: string }; readonly reason: string }
    | { readonly stage: 'saving' }
    | null
  >(null);

  const [learnEnabled, setLearnEnabled] = useState(true);

  const running = runningRequestId !== null;
  const composerDisabled = running || clarifyRequest !== null;
  const modelLabel = [status.providerName, status.model].filter(Boolean).join(' / ') || 'Local host';
  const showEmptyState = messages.every((message) => message.role === 'system');
  const agentLabel = (status.agentName ? status.agentName.charAt(0).toUpperCase() + status.agentName.slice(1) : 'Atlas');
  const isLocalProvider = settings?.ok && settings.defaultProvider === 'local';
  const powerMode = settings?.ok
    ? (isLocalProvider ? settings.vscodePowerMode : settings.atlasMode)
    : 'full';
  const mode = status.mode ?? 'plan';
  const thinking = status.thinking ?? 'off';
  const thinkingLabel = thinking !== 'off' ? thinking.toUpperCase() : null;
  const modelOptions = useMemo<readonly QuickOption[]>(() => (
    models?.models.map((model) => ({
      value: `${model.provider}:${model.id}`,
      label: model.id,
      description: `${model.providerLabel} · ${model.promptCacheLabel}${model.contextWindow ? ` · ${model.contextWindow.toLocaleString()} ctx` : ''}`,
    })) ?? [{ value: modelLabel, label: modelLabel }]
  ), [modelLabel, models]);
  const tokenStats = useMemo(() => {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    for (const m of messages) {
      if (m.usage) {
        promptTokens += m.usage.promptTokens;
        completionTokens += m.usage.completionTokens;
        totalTokens += m.usage.totalTokens;
      }
    }
    return { promptTokens, completionTokens, totalTokens };
  }, [messages]);

  const contextWindow = models?.models.find((m) => m.active)?.contextWindow ?? null;
  const tokenPercent = contextWindow && contextWindow > 0
    ? Math.round((tokenStats.totalTokens / contextWindow) * 100)
    : null;

  const postRequest = useCallback((kind: BridgeRequestKind, params: Record<string, unknown> = {}) => {
    const requestId = createRequestId();
    pendingRequestKindsRef.current.set(requestId, kind);
    if (kind === 'getModels') setModelsLoading(true);
    vscode.postMessage({ requestId, kind, params });
    return requestId;
  }, []);

  const slashSuggestions = useMemo(() => {
    const trimmedStart = prompt.trimStart();
    if (!trimmedStart.startsWith('/') || trimmedStart.includes(' ')) return [];
    const needle = trimmedStart.slice(1).toLowerCase();
    return slashCommands
      .filter((command) => command.name.startsWith(needle))
      .slice(0, 8);
  }, [prompt]);

  useEffect(() => {
    postRequest('getStatus');
    postRequest('getSettings');
    postRequest('getModels');
    postRequest('getAgents');
    postRequest('getMcpStatus');
    postRequest('getSessions');
    postRequest('getTaskStatus');
    postRequest('getTodos');
  }, [postRequest]);

  useEffect(() => {
    if (!actionNotice) return undefined;
    const timeout = window.setTimeout(() => setActionNotice(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [actionNotice]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      postRequest('getTaskStatus');
    }, 3000);
    return () => window.clearInterval(interval);
  }, [postRequest]);

  useEffect(() => {
    if (activeView === 'settings') postRequest('getSettings');
    if (activeView === 'mcp') postRequest('getMcpStatus');
    if (activeView === 'sessions') postRequest('getSessions');
    if (activeView === 'task') {
      postRequest('getTaskStatus');
      postRequest('getTodos');
    }
  }, [activeView, postRequest]);

  useEffect(() => {
    setSlashCursor(0);
  }, [slashSuggestions.length, prompt]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && selectorRailRef.current?.contains(event.target)) return;
      setOpenSelector(null);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (running) {
        event.preventDefault();
        postRequest('cancelTurn');
        return;
      }
      setOpenSelector(null);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [postRequest, running]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const listener = (event: MessageEvent<BridgeMessage>) => {
      const message = event.data;
      const requestKind = pendingRequestKindsRef.current.get(message.requestId);
      pendingRequestKindsRef.current.delete(message.requestId);
      if (requestKind === 'getModels') setModelsLoading(false);
      if (message.kind === 'response') {
        if (isStatusResult(message.result)) setStatus(message.result);
        if (isSettingsResult(message.result)) setSettings(message.result);
        if (isModelSummaryResult(message.result)) setModels(message.result);
        if (isAgentSummaryResult(message.result)) setAgents(message.result);
        if (isMcpStatusResult(message.result)) setMcpStatus(message.result);
        if (isSessionListResult(message.result)) setSessions(message.result);
        if (isTaskStatusResult(message.result)) setTaskStatus(message.result);
        if (isTodoStatusResult(message.result)) setTodos(message.result);
        if (isRuntimeActionResult(message.result)) {
          if (message.result.ok) {
            setActionNotice(actionNoticeFromResult(message.result));
            postRequest('getStatus');
            postRequest('getSettings');
            postRequest('getModels');
            postRequest('getAgents');
            postRequest('getMcpStatus');
            postRequest('getSessions');
            postRequest('getTaskStatus');
            postRequest('getTodos');
          } else {
            setActionNotice(`${message.result.error.code}: ${message.result.error.message}`);
          }
        }
        if (isOpenFileResult(message.result)) {
          const line = message.result.line === null ? '' : `:${message.result.line}`;
          setActionNotice(`Opened ${message.result.path}${line}`);
        } else if (isOpenConfigResult(message.result)) {
          setActionNotice(`Opened ${message.result.path}`);
        }
        if (isAttachFileResult(message.result)) {
          const result = message.result;
          if (result.ok && result['cancelled'] === true) {
            setActionNotice('Attachment cancelled.');
          } else if (result.ok && typeof result['path'] === 'string') {
            const filePath = result['path'];
            const name = filePath.slice(filePath.lastIndexOf('/') + 1).slice(filePath.lastIndexOf('\\') + 1);
            const b64 = result['base64'];
            const mt = result['mediaType'];
            const text = result['content'];
            if (typeof b64 === 'string' && typeof mt === 'string') {
              setAttachments((current) => [...current, {
                type: 'image',
                path: filePath,
                name,
                base64: b64,
                mediaType: mt,
              }]);
              setActionNotice(`Attached image: ${name}`);
            } else if (typeof text === 'string') {
              setAttachments((current) => [...current, {
                type: 'file',
                path: filePath,
                name,
                content: text,
              }]);
              setActionNotice(`Attached file: ${name}`);
            }
          }
        }
        if (message.requestId === runningRequestId) {
          setRunningRequestId(null);
          markAssistantDone(message.requestId, setMessages);
        }
        return;
      }

      if (message.kind === 'error') {
        if (message.requestId === runningRequestId) setRunningRequestId(null);
        if (requestKind === 'getModels') setModelsLoading(false);
        setActionNotice(`${message.error.code ?? 'ERROR'}: ${message.error.message}`);
        setMessages((current) => [...current, {
          id: createRequestId(),
          requestId: message.requestId,
          role: 'error',
          content: message.error.message,
        }]);
        return;
      }

      const streamEvent = message.event;
      applyStreamEvent(message.requestId, streamEvent, setMessages);
      if (streamEvent.type === 'approval_request') {
        setPendingApprovals((current) => [
          ...current.filter((approval) => approval.id !== streamEvent.approval.id),
          streamEvent.approval,
        ]);
      }
      if (streamEvent.type === 'approval_resolved') {
        setPendingApprovals((current) => current.filter((approval) => approval.id !== streamEvent.approvalId));
      }
      if (streamEvent.type === 'tool_result' || streamEvent.type === 'turn_end' || streamEvent.type === 'done') {
        postRequest('getTodos');
      }
      if (streamEvent.type === 'done' && message.requestId === runningRequestId) {
        setRunningRequestId(null);
      }
      if (streamEvent.type === 'error' && message.requestId === runningRequestId) {
        setRunningRequestId(null);
      }
      if (streamEvent.type === 'clarify_request') {
        setClarifyRequest(streamEvent.clarify);
      }
      if (streamEvent.type === 'clarify_resolved') {
        setClarifyRequest(null);
      }
      if (streamEvent.type === 'learn_reflecting') {
        setLearnState({ stage: 'reflecting', reason: streamEvent.reason });
      }
      if (streamEvent.type === 'learn_review') {
        setLearnState({ stage: 'review', draft: streamEvent.draft, reason: streamEvent.reason });
      }
      if (streamEvent.type === 'learn_nothing') {
        setActionNotice('Nothing reusable to learn here.');
        setLearnState(null);
      }
      if (streamEvent.type === 'learn_error') {
        setActionNotice(`Learn error: ${streamEvent.error}`);
        setLearnState(null);
      }
      if (streamEvent.type === 'learn_saved') {
        setActionNotice(`Saved learned skill: ${streamEvent.name}`);
        setLearnState(null);
      }
    };

    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [postRequest, runningRequestId]);

  const handleTopAction = useCallback((action: TopAction) => {
    setOpenSelector(null);
    switch (action.id) {
      case 'new':
        setActiveView('chat');
        setPrompt('');
        setMessages([{ ...welcomeMessage, id: createRequestId() }]);
        setActionNotice(null);
        postRequest('newSession');
        return;
      case 'history':
        setActiveView('sessions');
        setActionNotice(null);
        return;
    }
  }, [postRequest]);

  const openConfig = useCallback(() => {
    postRequest('openConfig');
  }, [postRequest]);

  const refreshSettings = useCallback(() => {
    setActionNotice(null);
    postRequest('getSettings');
  }, [postRequest]);

  const stagePrompt = useCallback((text: string) => {
    setActiveView('chat');
    setPrompt(text);
    setActionNotice(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      if (textareaRef.current) resizeTextarea(textareaRef.current);
    });
  }, []);

  const openFile = useCallback((reference: FileReference) => {
    setActionNotice(null);
    postRequest('openFile', {
      path: reference.path,
      ...(reference.line !== undefined ? { line: reference.line } : {}),
      ...(reference.column !== undefined ? { column: reference.column } : {}),
    });
  }, [postRequest]);

  const resolveApproval = useCallback((approvalId: string, action: ApprovalAction) => {
    setPendingApprovals((current) => current.filter((approval) => approval.id !== approvalId));
    postRequest('resolveApproval', { approvalId, action });
  }, [postRequest]);

  const stageSlashCommand = useCallback((command: SlashCommand) => {
    stagePrompt(`/${command.name} `);
    setSlashCursor(0);
  }, [stagePrompt]);

  const handleLocalSlashCommand = useCallback((input: string): boolean => {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return false;
    const [rawCommand = ''] = trimmed.slice(1).split(/\s+/, 1);
    const command = rawCommand.toLowerCase();

    switch (command) {
      case 'help':
        setMessages((current) => [...current, {
          id: createRequestId(),
          role: 'system',
          content: `Atlas VS Code commands\n${slashCommands.map((item) => `/${item.name.padEnd(9)} ${item.summary}`).join('\n')}`,
        }]);
        return true;
      case 'clear':
        setMessages([{ ...welcomeMessage, id: createRequestId() }]);
        return true;
      case 'config':
      case 'tools':
      case 'compact':
      case 'skills':
        setActiveView('settings');
        setActionNotice(`/${command} is mapped into the Atlas settings surface.`);
        return true;
      case 'mcps':
        setActiveView('mcp');
        setActionNotice(null);
        postRequest('getMcpStatus');
        return true;
      case 'status':
        setActiveView('task');
        setActionNotice(null);
        postRequest('getTaskStatus');
        postRequest('getTodos');
        return true;
      case 'model':
      case 'models':
        setOpenSelector('model');
        setActionNotice(null);
        postRequest('getModels');
        return true;
      case 'agent':
      case 'agents':
        setOpenSelector('agent');
        setActionNotice(agents && agents.switchableCount <= 1
          ? 'Install custom agents under ~/.atlas/agents to enable manual switching.'
          : null);
        postRequest('getAgents');
        return true;
      case 'history':
      case 'sessions':
      case 'resume':
        setActiveView('sessions');
        setActionNotice(null);
        postRequest('getSessions');
        return true;
      case 'quit':
      case 'exit':
        setActionNotice('Atlas stays open in the VS Code sidebar; close the view when you are done.');
        return true;
      case 'restart':
      case 'mode':
      case 'thinking':
      case 'next':
      case 'onboard':
      case 'back':
      case 'skip':
      case 'abort':
        setActionNotice(`/${command} is mapped but not fully ported in the VS Code: host yet.`);
        return true;
      case 'learn': {
        const arg = trimmed.slice(command.length + 1).trim();
        const sub = arg.toLowerCase().split(/\s+/)[0] ?? '';
        if (sub === 'on') {
          setLearnEnabled(true);
          postRequest('setLearnEnabled', { enabled: true });
          setActionNotice('Auto-learn is ON.');
          return true;
        }
        if (sub === 'off') {
          setLearnEnabled(false);
          postRequest('setLearnEnabled', { enabled: false });
          setActionNotice('Auto-learn is OFF.');
          return true;
        }
        if (sub === 'status') {
          setActionNotice(`Auto-learn: ${learnEnabled ? 'ON' : 'OFF'}`);
          return true;
        }
        if (sub === '' || sub === 'force') {
          postRequest('runLearnReflection', { force: sub === 'force' });
          return true;
        }
        setActionNotice('Usage: /learn [on|off|status|force]');
        return true;
      }
      default:
        return false;
    }
  }, [agents, postRequest]);

  const sendPrompt = useCallback((event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const nextPrompt = prompt.trim();
    if (nextPrompt.length === 0 || running || clarifyRequest !== null) return;

    if (handleLocalSlashCommand(nextPrompt)) {
      setPrompt('');
      if (textareaRef.current) textareaRef.current.style.height = '';
      return;
    }

    const requestId = createRequestId();
    setMessages((current) => [...current, {
      id: `${requestId}-user`,
      requestId,
      role: 'user',
      content: nextPrompt,
    }, {
      id: `${requestId}-assistant`,
      requestId,
      role: 'assistant',
      content: '',
      tools: [],
      pending: true,
    }]);
    setRunningRequestId(requestId);
    const bridgeAttachments = attachments.map((a) =>
      a.type === 'file'
        ? { type: 'file' as const, path: a.path, content: a.content }
        : { type: 'image' as const, path: a.path, base64: a.base64, mediaType: a.mediaType }
    );
    vscode.postMessage({ requestId, kind: 'runTurn', params: { prompt: nextPrompt, attachments: bridgeAttachments } });
    setPrompt('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = '';
  }, [handleLocalSlashCommand, prompt, running]);

  const resizeComposer = useCallback((target: HTMLTextAreaElement) => {
    resizeTextarea(target);
  }, []);

  const updatePrompt = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(event.currentTarget.value);
    resizeComposer(event.currentTarget);
  }, [resizeComposer]);

  const handleComposerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (running && event.key === 'Escape') {
      event.preventDefault();
      postRequest('cancelTurn');
      return;
    }
    if (slashSuggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSlashCursor((current) => current >= slashSuggestions.length - 1 ? 0 : current + 1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSlashCursor((current) => current <= 0 ? slashSuggestions.length - 1 : current - 1);
        return;
      }
      if ((event.key === 'Tab' || event.key === 'Enter') && !event.shiftKey) {
        event.preventDefault();
        stageSlashCommand(slashSuggestions[slashCursor] ?? slashSuggestions[0]!);
        return;
      }
    }
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      postRequest('getAgents');
      if ((agents?.switchableCount ?? 0) > 1) {
        setOpenSelector('agent');
        setActionNotice(null);
      } else {
        setActionNotice('Install custom agents under ~/.atlas/agents to enable manual switching.');
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      postRequest('getModels');
      setOpenSelector('model');
      setActionNotice(null);
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    sendPrompt();
  }, [agents, postRequest, running, sendPrompt, slashCursor, slashSuggestions, stageSlashCommand]);

  const handlePaste = useCallback(async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && item.type.startsWith('image/')) {
        imageItems.push(item);
      }
    }
    if (imageItems.length === 0) return;
    event.preventDefault();

    const activeModel = models?.models.find((m) => m.active);
    if (!activeModel?.supportsVision) {
      setActionNotice('Current model does not support vision. Paste cancelled.');
      return;
    }

    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const arrayBuffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );
      const mediaType = file.type || 'image/png';
      const name = file.name || `pasted-image-${Date.now()}.${mediaType.split('/')[1] || 'png'}`;
      setAttachments((current) => [...current, {
        type: 'image',
        path: name,
        name,
        base64,
        mediaType,
      }]);
      setActionNotice(`Pasted image: ${name}`);
    }
  }, [models]);

  return (
    <main className={`atlasShell ${activeView !== 'chat' ? 'hasSettings' : ''}`}>
      <header className="topBar">
        <div className="brandLockup" aria-label="Atlas OS">
          <img className="brandLogo" src={atlasLogoUrl} alt="" aria-hidden="true" />
        </div>
        <div className="headerChips">
          {powerMode ? (
            <button
              type="button"
              className="powerBadge"
              title={`Atlas power: ${powerMode}. Click to cycle.`}
              onClick={() => {
                if (isLocalProvider) {
                  const next = powerMode === 'lite' ? 'hybrid' : powerMode === 'hybrid' ? 'full' : 'lite';
                  postRequest('updateSettings', { vscodePowerMode: next });
                  setSettings((prev) => prev?.ok ? { ...prev, vscodePowerMode: next } : prev);
                } else {
                  const next = powerMode === 'full' ? 'smart' : 'full';
                  postRequest('updateSettings', { atlasMode: next });
                  setSettings((prev) => prev?.ok ? { ...prev, atlasMode: next } : prev);
                }
              }}
            >
              <span className="powerLabel">MODE:</span>
              {isLocalProvider ? (
                <span className={powerMode === 'full' ? 'powerFull' : powerMode === 'hybrid' ? 'powerHybrid' : 'powerLite'}>
                  {powerMode === 'full' ? 'FULL' : powerMode === 'hybrid' ? 'HYBRID' : 'LITE'}
                </span>
              ) : (
                <span className={powerMode === 'full' ? 'powerFull' : 'powerSmart'}>
                  {powerMode === 'full' ? 'POWER' : 'SMART'}
                </span>
              )}
              <i className="codicon codicon-chevron-right powerChevron" aria-hidden="true" />
            </button>
          ) : null}
          {thinkingLabel ? (
            <button
              type="button"
              className="thinkingChip"
              title={`Thinking: ${thinkingLabel}. Ctrl+T to cycle.`}
              onClick={() => {
                const available = models?.models.find((m) => m.active)?.thinking ?? ['off'];
                const next = nextThinking(thinking, available);
                postRequest('setThinking', { level: next });
              }}
            >
              {thinkingLabel}
            </button>
          ) : null}
          <span className="tokenUsageChip">
            {tokenPercent !== null ? `${tokenPercent}%` : ''}
            {tokenStats.totalTokens > 0 ? ` · ${tokenStats.promptTokens.toLocaleString()} in / ${tokenStats.completionTokens.toLocaleString()} out` : ''}
          </span>
        </div>
        <nav className="topActions" aria-label="Atlas actions">
          {topActions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="topIconButton"
              title={action.label}
              aria-label={action.label}
              onClick={() => handleTopAction(action)}
            >
              <i className={`codicon codicon-${action.icon}`} aria-hidden="true" />
            </button>
          ))}
          <button
            type="button"
            className="sessionButton"
            title="Session"
            aria-label="Session"
            onClick={() => setShowSessionPanel((s) => !s)}
          >
            Session
          </button>
        </nav>
      </header>

      {openSelector === 'agent' && agents ? (
        <div className="agentOverlay" onClick={() => setOpenSelector(null)}>
          <div className="agentPanel" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>Agents</h3>
              <button type="button" onClick={() => setOpenSelector(null)} aria-label="Close agents">
                <i className="codicon codicon-close" aria-hidden="true" />
              </button>
            </header>
            <div className="agentPanelBody">
              {agents.agents.map((agent) => (
                <button
                  key={agent.name}
                  type="button"
                  className={`agentPanelRow ${agent.active ? 'isActive' : ''} ${agent.switchable ? '' : 'isLocked'}`}
                  disabled={!agent.switchable}
                  onClick={() => {
                    if (agent.switchable) {
                      postRequest('selectAgent', { name: agent.name });
                      setOpenSelector(null);
                    }
                  }}
                >
                  <div className="agentPanelInfo">
                    <strong>{agent.name}</strong>
                    <span>{agent.role}{agent.kind === 'framework' ? ' · framework' : ''}</span>
                  </div>
                  <div className="agentPanelStatus">
                    {agent.active ? (
                      <span className="agentPanelActive">active</span>
                    ) : agent.switchable ? (
                      <span>select</span>
                    ) : (
                      <i className="codicon codicon-lock" aria-hidden="true" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {showSessionPanel ? (
        <div className="sessionOverlay" onClick={() => setShowSessionPanel(false)}>
          <div className="sessionPanel" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>Session Details</h3>
              <button type="button" onClick={() => setShowSessionPanel(false)} aria-label="Close session panel">
                <i className="codicon codicon-close" aria-hidden="true" />
              </button>
            </header>
            <p className="sessionPanelSubtitle">Details for this conversation.</p>
            <div className="sessionPanelBody">
              <div className="sessionPanelField">
                <span>Session ID</span>
                <strong>{sessionId}</strong>
              </div>
              <div className="sessionPanelField">
                <span>Messages</span>
                <strong>{messages.filter((m) => m.role !== 'system').length}</strong>
              </div>
              <div className="sessionPanelField">
                <span>Token Usage</span>
                <div className="sessionTokenGrid">
                  <div>
                    <small>Percent</small>
                    <strong>{tokenPercent !== null ? `${tokenPercent}%` : '—'}</strong>
                  </div>
                  <div>
                    <small>Input</small>
                    <strong>{tokenStats.promptTokens.toLocaleString()}</strong>
                  </div>
                  <div>
                    <small>Output</small>
                    <strong>{tokenStats.completionTokens.toLocaleString()}</strong>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {status.error && activeView === 'chat' ? (
        <section className="setupBanner" aria-live="polite">
          <span className="bannerLabel">{status.error.code ?? 'setup'}</span>
          <p>{status.error.message}</p>
        </section>
      ) : null}

      {activeView === 'settings' ? (
        <SettingsScreen
          settings={settings}
          status={status}
          models={models}
          modelsLoading={modelsLoading}
          agents={agents}
          sessions={sessions}
          notice={actionNotice}
          onBack={() => setActiveView('chat')}
          onOpenConfig={openConfig}
          onRefresh={refreshSettings}
          onManageMcp={() => setActiveView('mcp')}
          onManageAgents={() => {
            setActiveView('chat');
            setOpenSelector('agent');
            postRequest('getAgents');
          }}
          onManageSessions={() => setActiveView('sessions')}
          onUseCommand={(command) => stagePrompt(command)}
          onRefreshModels={() => {
            setActionNotice('Refreshing model catalog...');
            postRequest('getModels', { forceRefresh: true });
          }}
          onSelectModel={(model) => postRequest('selectModel', { id: model.id, provider: model.provider })}
          onPromptSecret={(key) => postRequest('promptSecret', { key })}
          onStoreSecret={(key, value) => postRequest('storeSecret', { key, value })}
          onClearSecret={(key) => postRequest('clearSecret', { key })}
          onSignInCodex={() => postRequest('signInCodex')}
          onUpdateSettings={(update) => postRequest('updateSettings', update)}
        />
      ) : activeView === 'mcp' ? (
        <McpScreen
          status={mcpStatus}
          notice={actionNotice}
          onBack={() => setActiveView('chat')}
          onRefresh={() => postRequest('getMcpStatus')}
          onOpenConfig={openConfig}
          onSetEnabled={(name, enabled) => postRequest('setMcpEnabled', { name, enabled })}
          onAdd={(name) => postRequest('addMcpServer', { name })}
          onUpsert={(server) => postRequest('upsertMcpServer', server)}
          onRemove={(name) => postRequest('removeMcpServer', { name })}
        />
      ) : activeView === 'sessions' ? (
        <SessionsScreen
          sessions={sessions}
          notice={actionNotice}
          onBack={() => setActiveView('chat')}
          onRefresh={() => postRequest('getSessions')}
          onNew={() => {
            setMessages([{ ...welcomeMessage, id: createRequestId() }]);
            postRequest('newSession');
          }}
          onResume={(id) => {
            setActiveView('chat');
            setMessages([{ ...welcomeMessage, id: createRequestId(), content: `Resumed ${id}.` }]);
            postRequest('resumeSession', { id });
          }}
          onRename={(session) => postRequest('promptRenameSession', { id: session.id, title: session.title })}
          onDelete={(id) => postRequest('deleteSession', { id })}
        />
      ) : activeView === 'task' ? (
        <TaskScreen
          status={taskStatus}
          todos={todos}
          notice={actionNotice}
          onBack={() => setActiveView('chat')}
          onRefresh={() => {
            postRequest('getTaskStatus');
            postRequest('getTodos');
          }}
        />
      ) : (
        <>
          {actionNotice ? <div className="actionNotice" role="status">{actionNotice}</div> : null}
          <section ref={transcriptRef} className={`transcript ${taskStatus?.task?.phase && taskStatus.task.phase !== 'idle' && taskStatus.task.phase !== 'discover' ? `transcript-mode-${taskStatus.task.phase === 'plan' ? 'plan' : taskStatus.task.phase === 'execute' || taskStatus.task.phase === 'verify' ? 'build' : 'autopilot'}` : ''}`} aria-live="polite">
            {taskStatus?.task?.phase && taskStatus.task.phase !== 'idle' && taskStatus.task.phase !== 'discover' ? <div className="transcriptPhaseLabel">{taskStatus.task.phase.toUpperCase()}</div> : null}
            {showEmptyState ? (
              <EmptyState />
            ) : (
              messages.filter((message) => message.role !== 'system').map((message) => (
                <ChatBubble key={message.id} message={message} onOpenFile={openFile} />
              ))
            )}
            {learnState ? (
              <LearnCard
                state={learnState}
                onSave={() => postRequest('resolveLearn', { action: 'save' })}
                onEdit={(changeRequest: string) => postRequest('resolveLearn', { action: 'edit', changeRequest })}
                onDiscard={() => postRequest('resolveLearn', { action: 'discard' })}
                onBack={() => setLearnState((current) => current?.stage === 'change' ? { stage: 'review', draft: current.draft, reason: current.reason } : current)}
              />
            ) : null}
          </section>
          {pendingApprovals.length > 0 ? (
            <ApprovalRail approvals={pendingApprovals} onResolve={resolveApproval} />
          ) : null}

          {clarifyRequest ? (
            <ClarifyCard
              request={clarifyRequest}
              onChoose={(answer) => {
                postRequest('resolveClarify', { clarifyId: clarifyRequest.id, answer });
                setClarifyRequest(null);
                setPrompt(answer);
                // Auto-submit as next user turn for protocol questions
                setTimeout(() => {
                  const form = document.querySelector('.composer') as HTMLFormElement | null;
                  if (form) form.requestSubmit();
                }, 0);
              }}
              onDismiss={() => {
                postRequest('resolveClarify', { clarifyId: clarifyRequest.id, answer: '' });
                setClarifyRequest(null);
              }}
            />
          ) : null}

          {mode === 'autopilot' ? (
            <footer className="statusBar">
              <span className="statusBarWarning">⚠ AUTOPILOT</span>
            </footer>
          ) : null}

          <form className={`composer ${running ? 'isRunning' : ''}`} onSubmit={sendPrompt}>
            {attachments.length > 0 ? (
              <div className="attachmentList">
                {attachments.map((att, idx) => (
                  <div key={`${att.path}-${idx}`} className="attachmentPill">
                    {att.type === 'image' ? (
                      <img
                        src={`data:${att.mediaType};base64,${att.base64}`}
                        alt={att.name}
                        className="attachmentThumbnail"
                      />
                    ) : (
                      <i className="codicon codicon-file" aria-hidden="true" />
                    )}
                    <span className="attachmentName">{att.name}</span>
                    <button
                      type="button"
                      className="attachmentRemove"
                      title="Remove attachment"
                      onClick={() => setAttachments((current) => current.filter((_, i) => i !== idx))}
                    >
                      <i className="codicon codicon-close" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {slashSuggestions.length > 0 ? (
              <SlashAutocomplete
                commands={slashSuggestions}
                activeIndex={slashCursor}
                onPick={stageSlashCommand}
              />
            ) : null}
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={updatePrompt}
              onKeyDown={handleComposerKeyDown}
              onPaste={handlePaste}
              rows={2}
              placeholder="Describe what you want to build..."
              disabled={composerDisabled}
            />
            <div className="composerControls">
              <div ref={selectorRailRef} className="composerControlsLeft">
                <button
                  type="button"
                  className="composerAgentIcon"
                  title={`Agent: ${agentLabel}`}
                  aria-label={`Agent: ${agentLabel}`}
                  onClick={() => {
                    postRequest('getAgents');
                    setOpenSelector((current) => current === 'agent' ? null : 'agent');
                  }}
                >
                  <img src={octopusIconUrl} alt="" aria-hidden="true" width={16} height={16} style={{ filter: 'invert(1)' }} />
                </button>
                <QuickSelect
                  label="Atlas model"
                  value={models?.activeModel ?? modelLabel}
                  options={modelOptions}
                  isOpen={openSelector === 'model'}
                  grouped
                  popularFilter={isPopularModelId}
                  minimal
                  onToggle={() => {
                    postRequest('getModels');
                    setOpenSelector((current) => current === 'model' ? null : 'model');
                  }}
                  onSelect={(option) => {
                    setOpenSelector(null);
                    const model = models?.models.find((item) => `${item.provider}:${item.id}` === option.value);
                    if (model) postRequest('selectModel', { id: model.id, provider: model.provider });
                  }}
                />
                {models?.activeModel ? (
                  <div className="composerThinkingWrap">
                    <button
                      type="button"
                      className={`composerThinkingIcon ${thinking !== 'off' ? 'isActive' : ''}`}
                      title={`Thinking: ${thinking.toUpperCase()}`}
                      onClick={() => setOpenSelector((current) => current === 'thinking' ? null : 'thinking')}
                    >
                      {thinking === 'off' ? (
                        <i className="codicon codicon-lightbulb" aria-hidden="true" />
                      ) : (
                        <span className="composerThinkingLabel">{thinking.toUpperCase()}</span>
                      )}
                    </button>
                    {openSelector === 'thinking' ? (
                      <div className="thinkingDropdown">
                        {(models?.models.find((m) => m.active)?.thinking ?? ['off']).map((level) => (
                          <button
                            key={level}
                            type="button"
                            className={`thinkingDropdownOption ${level === thinking ? 'isActive' : ''}`}
                            onClick={() => {
                              postRequest('setThinking', { level });
                              setOpenSelector(null);
                            }}
                          >
                            {level.toUpperCase()}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="composerControlsRight">
                <button
                  type="button"
                  className="composerSettingsButton"
                  title="Settings"
                  aria-label="Settings"
                  onClick={() => setActiveView('settings')}
                >
                  <i className="codicon codicon-gear" aria-hidden="true" />
                </button>
                <div style={{ position: 'relative' }}>
                  <button
                    type="button"
                    className="composerAttachButton"
                    title="Attach"
                    aria-label="Attach file or image"
                    onClick={() => setOpenSelector((current) => current === 'attach' ? null : 'attach')}
                  >
                    <i className="codicon codicon-add" aria-hidden="true" />
                  </button>
                  {openSelector === 'attach' ? (
                    <div className="attachDropdown">
                      <button
                        type="button"
                        className="attachDropdownOption"
                        onClick={() => {
                          postRequest('attachFile', { type: 'file' });
                          setOpenSelector(null);
                        }}
                      >
                        <i className="codicon codicon-file" aria-hidden="true" />
                        <span>Attach file</span>
                      </button>
                      {(models?.models.find((m) => m.active)?.supportsVision ?? false) ? (
                        <button
                          type="button"
                          className="attachDropdownOption"
                          onClick={() => {
                            postRequest('attachFile', { type: 'image' });
                            setOpenSelector(null);
                          }}
                        >
                          <i className="codicon codicon-file-media" aria-hidden="true" />
                          <span>Attach image</span>
                        </button>
                      ) : (
                        <div className="attachDropdownOption isDisabled" title="Current model does not support vision">
                          <i className="codicon codicon-file-media" aria-hidden="true" />
                          <span>Attach image (unsupported)</span>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
                <button
                  type="submit"
                  className={`sendButton ${running ? 'isStop' : ''}`}
                  title={running ? 'Stop Atlas turn' : 'Send message (Enter)'}
                  aria-label={running ? 'Stop Atlas turn' : 'Send message'}
                  disabled={!running && prompt.trim().length === 0}
                  onClick={(event) => {
                    if (!running) return;
                    event.preventDefault();
                    postRequest('cancelTurn');
                  }}
                >
                  <i className={`codicon codicon-${running ? 'debug-stop' : 'send'}`} aria-hidden="true" />
                </button>
              </div>
            </div>
            </form>
        </>
      )}
    </main>
  );
}

function EmptyState(): ReactElement {
  return (
    <div className="emptyState">
      <img className="emptyMark" src={atlasMarkUrl} alt="Atlas" />
      <p>Atlas is your local agent crew.</p>
      <span>Ask it to build features, investigate bugs, or explain your codebase.</span>
    </div>
  );
}

function ApprovalRail({
  approvals,
  onResolve,
}: {
  readonly approvals: readonly InlineApprovalRequest[];
  readonly onResolve: (approvalId: string, action: ApprovalAction) => void;
}): ReactElement {
  return (
    <section className="approvalRail" aria-label="Pending tool approvals">
      {approvals.map((approval) => (
        <article key={approval.id} className="approvalCard">
          <div className="approvalHeader">
            <span><i className="codicon codicon-shield" aria-hidden="true" /> {approval.tool}</span>
            <small>{formatDate(approval.createdAt)}</small>
          </div>
          <pre>{approval.preview}</pre>
          <div className="approvalActions">
            <button type="button" className="settingsSecondaryButton" onClick={() => onResolve(approval.id, 'deny')}>
              <i className="codicon codicon-close" aria-hidden="true" />
              Deny
            </button>
            <button type="button" className="settingsPrimaryButton" onClick={() => onResolve(approval.id, 'allow')}>
              <i className="codicon codicon-check" aria-hidden="true" />
              Allow
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

function ClarifyCard({
  request,
  onChoose,
  onDismiss,
}: {
  readonly request: {
    readonly id: string;
    readonly question: string;
    readonly choices?: readonly string[];
    readonly allowFreeform: boolean;
  };
  readonly onChoose: (answer: string) => void;
  readonly onDismiss: () => void;
}): ReactElement {
  const [freeform, setFreeform] = useState('');
  const [showFreeform, setShowFreeform] = useState(false);

  return (
    <section className="clarifyCard" aria-label="Clarification request">
      <div className="clarifyHeader">
        <i className="codicon codicon-question" aria-hidden="true" />
        <span>{request.question}</span>
      </div>
      <div className="clarifyChoices">
        {request.choices?.map((choice) => (
          <button
            key={choice}
            type="button"
            className="clarifyChoice"
            onClick={() => onChoose(choice)}
          >
            {choice}
          </button>
        ))}
        {request.allowFreeform && !showFreeform ? (
          <button
            type="button"
            className="clarifyChoice clarifyChoice-freeform"
            onClick={() => setShowFreeform(true)}
          >
            Type your own answer…
          </button>
        ) : null}
        {showFreeform ? (
          <div className="clarifyFreeform">
            <input
              type="text"
              value={freeform}
              onChange={(e) => setFreeform(e.target.value)}
              placeholder="Your answer…"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && freeform.trim().length > 0) {
                  onChoose(freeform.trim());
                }
              }}
              autoFocus
            />
            <button
              type="button"
              className="settingsPrimaryButton"
              disabled={freeform.trim().length === 0}
              onClick={() => onChoose(freeform.trim())}
            >
              Submit
            </button>
          </div>
        ) : null}
      </div>
      <button type="button" className="clarifyDismiss" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}

function LearnCard({
  state,
  onSave,
  onEdit,
  onDiscard,
  onBack,
}: {
  readonly state:
    | { readonly stage: 'reflecting'; readonly reason: string }
    | { readonly stage: 'review'; readonly draft: { readonly name: string; readonly description: string; readonly triggers: readonly string[]; readonly body: string }; readonly reason: string }
    | { readonly stage: 'change'; readonly draft: { readonly name: string; readonly description: string; readonly triggers: readonly string[]; readonly body: string }; readonly reason: string }
    | { readonly stage: 'saving' };
  readonly onSave: () => void;
  readonly onEdit: (changeRequest: string) => void;
  readonly onDiscard: () => void;
  readonly onBack: () => void;
}): ReactElement {
  const [changeRequest, setChangeRequest] = useState('');

  if (state.stage === 'reflecting') {
    return (
      <section className="learnCard learnCard-reflecting" aria-label="Learning reflection">
        <div className="learnCardHeader">
          <i className="codicon codicon-sync codicon-spin" aria-hidden="true" />
          <span>Atlas is drafting a learned skill…</span>
        </div>
        <p className="learnCardReason">{state.reason}</p>
        <button type="button" className="settingsSecondaryButton" onClick={onDiscard}>
          Cancel
        </button>
      </section>
    );
  }

  if (state.stage === 'saving') {
    return (
      <section className="learnCard learnCard-saving" aria-label="Saving learned skill">
        <div className="learnCardHeader">
          <i className="codicon codicon-sync codicon-spin" aria-hidden="true" />
          <span>Saving learned skill to ~/.atlas/skills/…</span>
        </div>
      </section>
    );
  }

  if (state.stage === 'change') {
    return (
      <section className="learnCard learnCard-change" aria-label="Revise learned skill">
        <div className="learnCardHeader">
          <i className="codicon codicon-edit" aria-hidden="true" />
          <span>Change learned skill · {state.draft.name}</span>
        </div>
        <textarea
          className="learnCardTextarea"
          rows={3}
          placeholder="Describe what to change…"
          value={changeRequest}
          onChange={(e) => setChangeRequest(e.target.value)}
        />
        <div className="learnCardActions">
          <button type="button" className="settingsSecondaryButton" onClick={onBack}>
            Back
          </button>
          <button
            type="button"
            className="settingsPrimaryButton"
            disabled={changeRequest.trim().length === 0}
            onClick={() => {
              onEdit(changeRequest.trim());
              setChangeRequest('');
            }}
          >
            Submit change
          </button>
        </div>
      </section>
    );
  }

  // review stage
  return (
    <section className="learnCard learnCard-review" aria-label="Review learned skill">
      <div className="learnCardHeader">
        <i className="codicon codicon-lightbulb" aria-hidden="true" />
        <span>Learned skill draft · {state.draft.name}</span>
      </div>
      <p className="learnCardDescription">{state.draft.description}</p>
      <pre className="learnCardBody">{state.draft.body}</pre>
      <div className="learnCardActions">
        <button type="button" className="settingsSecondaryButton" onClick={onDiscard}>
          Discard
        </button>
        <button type="button" className="settingsSecondaryButton" onClick={() => onEdit('')}>
          Request change
        </button>
        <button type="button" className="settingsPrimaryButton" onClick={onSave}>
          Save
        </button>
      </div>
    </section>
  );
}

function SettingsScreen({
  settings,
  status,
  models,
  modelsLoading,
  agents,
  sessions,
  notice,
  onBack,
  onOpenConfig,
  onRefresh,
  onManageMcp,
  onManageAgents,
  onManageSessions,
  onUseCommand,
  onRefreshModels,
  onSelectModel,
  onPromptSecret,
  onStoreSecret,
  onClearSecret,
  onSignInCodex,
  onUpdateSettings,
}: {
  readonly settings: SettingsSummaryResult | null;
  readonly status: AtlasStatus;
  readonly models: ModelSummaryResult | null;
  readonly modelsLoading: boolean;
  readonly agents: AgentSummaryResult | null;
  readonly sessions: SessionListResult | null;
  readonly notice: string | null;
  readonly onBack: () => void;
  readonly onOpenConfig: () => void;
  readonly onRefresh: () => void;
  readonly onManageMcp: () => void;
  readonly onManageAgents: () => void;
  readonly onManageSessions: () => void;
  readonly onUseCommand: (command: string) => void;
  readonly onRefreshModels: () => void;
  readonly onSelectModel: (model: ModelSummary) => void;
  readonly onPromptSecret: (key: PromptSecretKey) => void;
  readonly onStoreSecret: (key: PromptSecretKey, value: string) => void;
  readonly onClearSecret: (key: PromptSecretKey) => void;
  readonly onSignInCodex: () => void;
  readonly onUpdateSettings: (update: SafeSettingsUpdate) => void;
}): ReactElement {
  const [modelSearch, setModelSearch] = useState('');
  const [settingsSearch, setSettingsSearch] = useState('');
  const [defaultModelSearch, setDefaultModelSearch] = useState('');
  const [modelProviderFilter, setModelProviderFilter] = useState<ModelProviderFilter>('all');
  const [defaultModelPickerOpen, setDefaultModelPickerOpen] = useState(false);
  const [settingsDetail, setSettingsDetail] = useState<SettingsDetail | null>(null);
  const [authProvider, setAuthProvider] = useState<AuthProviderId | null>(null);
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(() => new Set([
    'general',
    'provider-keys',
    'models',
    'power-mode',
    'local-models',
    'mcp',
  ]));
  const [localBaseUrlDraft, setLocalBaseUrlDraft] = useState('');
  const [localTimeoutDraft, setLocalTimeoutDraft] = useState('');
  const [compactionModelDraft, setCompactionModelDraft] = useState('');
  const [compactionContextDraft, setCompactionContextDraft] = useState('');

  useEffect(() => {
    if (!settings?.ok) return;
    setLocalBaseUrlDraft(settings.providers.local.baseUrl);
    setLocalTimeoutDraft(String(settings.providers.local.requestTimeoutMs));
    setCompactionModelDraft(settings.compaction.model ?? settings.routerModel ?? '');
    setCompactionContextDraft(String(settings.compaction.contextTokens));
  }, [settings]);

  if (!settings) {
    return (
      <section className="settingsView settingsView-showcase">
        <SettingsHeader title="Settings" subtitle="Configure Atlas to fit your workflow." onBack={onBack} onOpenConfig={onOpenConfig} onRefresh={onRefresh} variant="showcase" />
        <div className="settingsLoading">Reading Atlas core config...</div>
      </section>
    );
  }

  if (!settings.ok) {
    return (
      <section className="settingsView settingsView-showcase">
        <SettingsHeader title="Settings" subtitle="Configure Atlas to fit your workflow." onBack={onBack} onOpenConfig={onOpenConfig} onRefresh={onRefresh} variant="showcase" />
        <div className="settingsError">
          <StatusPill tone="warn" label={settings.error.code} />
          <p>{settings.error.message}</p>
        </div>
      </section>
    );
  }

  const providerRows = [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      detail: `${settings.providers.openrouter.customModels} custom · ${settings.providers.openrouter.fallbackKeys} fallback`,
      configured: settings.providers.openrouter.configured,
      secretKey: 'openrouter.apiKey',
      authProvider: 'openrouter',
      icon: 'source-control',
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      detail: settings.providers.anthropic.oauthEnabled ? 'Claude Code OAuth enabled' : `${settings.providers.anthropic.fallbackKeys} fallback keys`,
      configured: settings.providers.anthropic.configured || settings.providers.anthropic.oauthEnabled,
      secretKey: 'anthropic.apiKey',
      authProvider: 'anthropic',
      icon: 'anthropic',
    },
    {
      id: 'openai-codex',
      name: 'OpenAI',
      detail: settings.providers.openaiCodex.authMode === 'apiKey'
        ? 'OpenAI API key'
        : settings.providers.openaiCodex.accountId ?? 'browser PKCE flow',
      configured: settings.providers.openaiCodex.configured,
      secretKey: 'openai.apiKey',
      authProvider: 'openai',
      icon: 'openai',
    },
    {
      id: 'opencode-zen',
      name: 'OpenCode Zen',
      detail: `${settings.providers.opencodeZen.customModels} custom models`,
      configured: settings.providers.opencodeZen.configured,
      secretKey: 'opencode.zen.apiKey',
      authProvider: 'opencode-zen',
      icon: 'symbol-misc',
    },
    {
      id: 'opencode-go',
      name: 'OpenCode Go',
      detail: `${settings.providers.opencodeGo.customModels} custom models`,
      configured: settings.providers.opencodeGo.configured,
      secretKey: 'opencode.go.apiKey',
      authProvider: 'opencode-go',
      icon: 'arrow-swap',
    },
  ] as const;

  const allModels = models?.models ?? [];
  const modelNeedle = modelSearch.trim().toLowerCase();
  const filteredModels = allModels.filter((model) => (
    modelMatchesFilter(model, modelProviderFilter)
    && (
      modelNeedle.length === 0
      || model.id.toLowerCase().includes(modelNeedle)
      || model.label.toLowerCase().includes(modelNeedle)
      || model.providerLabel.toLowerCase().includes(modelNeedle)
    )
  ));
  const modelProviderTabs: readonly { readonly label: string; readonly filter: ModelProviderFilter }[] = [
    { label: `All ${allModels.length}`, filter: 'all' },
    { label: `OpenRouter ${countModelsForFilter(allModels, 'openrouter')}`, filter: 'openrouter' },
    { label: `Anthropic ${countModelsForFilter(allModels, 'anthropic')}`, filter: 'anthropic' },
    { label: `OpenAI ${countModelsForFilter(allModels, 'openai-codex')}`, filter: 'openai-codex' },
    { label: `Local ${countModelsForFilter(allModels, 'local')}`, filter: 'local' },
    { label: `OpenCode ${countModelsForFilter(allModels, 'opencode')}`, filter: 'opencode' },
  ];

  const guardrailItems = [
    {
      label: 'Dangerous commands',
      enabled: settings.guardrails.dangerousCommand,
      updateKey: 'guardrailDangerousCommand',
      description: 'Blocks destructive shell and git commands before they reach the terminal approval flow.',
    },
    {
      label: 'Path safety',
      enabled: settings.guardrails.pathSafety,
      updateKey: 'guardrailPathSafety',
      description: 'Stops reads and writes against protected paths such as .git, .env, ~/.ssh, and paths outside the workspace.',
    },
    {
      label: 'Secret redaction',
      enabled: settings.guardrails.secretRedaction,
      updateKey: 'guardrailSecretRedaction',
      description: 'Redacts API keys, access tokens, private keys, and common credential patterns from tool output.',
    },
    {
      label: 'Prompt injection',
      enabled: settings.guardrails.promptInjectionDetector,
      updateKey: 'guardrailPromptInjectionDetector',
      description: 'Flags suspicious instructions found in retrieved content so Atlas can treat them as untrusted data.',
    },
    {
      label: 'Discover checks',
      enabled: settings.guardrails.discoverGuardrails,
      updateKey: 'guardrailDiscoverGuardrails',
      description: 'Keeps discovery disciplined by forcing clarification for vague input and warning on contradictory context.',
    },
    {
      label: 'Progress tracker',
      enabled: settings.guardrails.progressTracker,
      updateKey: 'guardrailProgressTracker',
      description: 'Appends commit decisions to context/progress-tracker.md when Atlas lands changes through the terminal tool.',
    },
  ] as const;
  const agentRows = (agents?.agents ?? [
    {
      name: 'atlas',
      role: 'Orchestrator',
      description: 'Routes Atlas work.',
      kind: 'framework' as const,
      active: true,
      switchable: true,
    },
  ]).slice(0, 7);
  const toolRows = settings.tools;
  const lifecycleHooks = [
    'sessionStart',
    'beforeMessage',
    'afterMessage',
    'beforeTool',
    'afterTool',
    'sessionEnd',
  ] as const;
  const approvalRows = [
    {
      label: 'Terminal',
      value: 'ask',
      detail: {
        title: 'Terminal Approval',
        description: 'Terminal commands run through VS Code inline approval. Read-like commands can be approved quickly, while risky shell operations are blocked or require explicit consent.',
        rows: [
          { label: 'Default', value: 'ask' },
          { label: 'Related tool', value: 'terminal' },
        ],
      },
    },
    {
      label: 'File edits',
      value: 'ask',
      detail: {
        title: 'File Edit Approval',
        description: 'Writes are validated by tool schemas and surfaced through approval-aware edit tools. Path safety can still block protected files before approval.',
        rows: [
          { label: 'Default', value: 'ask' },
          { label: 'Related tools', value: 'write_file, edit_file' },
        ],
      },
    },
    {
      label: 'Read files',
      value: 'auto',
      detail: {
        title: 'Read File Policy',
        description: 'Workspace reads are normally automatic so Atlas can inspect code quickly. Path safety guardrails still prevent sensitive or out-of-workspace reads.',
        rows: [
          { label: 'Default', value: 'auto' },
          { label: 'Related tool', value: 'read_file' },
        ],
      },
    },
    {
      label: 'Dangerous commands',
      value: 'never',
      detail: {
        title: 'Dangerous Command Guard',
        description: 'Known destructive commands are refused by hooks before they can execute. Add extra denied command fragments in config.yaml for project-specific rules.',
        rows: [
          { label: 'Default', value: 'never' },
          { label: 'Config field', value: 'guardrails.dangerousCommand' },
        ],
      },
    },
  ] as const;
  const sessionCount = sessions?.sessions.length ?? 0;
  const defaultProviders = [
    ['openrouter', 'OpenRouter'],
    ['anthropic', 'Anthropic'],
    ['openai-codex', 'OpenAI / Codex'],
    ['local', 'Local'],
    ['opencode-zen', 'OpenCode Zen'],
    ['opencode-go', 'OpenCode Go'],
  ] as const;
  const compactionThresholdOptions = [0.6, 0.7, 0.8, 0.9, 0.95] as const;
  const settingsSections = [
    { id: 'general', title: 'General', index: 1, keywords: 'default provider default model atlas mode refresh catalog' },
    { id: 'provider-keys', title: 'Provider Keys', index: 2, keywords: 'auth api key oauth openrouter anthropic openai opencode local github' },
    { id: 'models', title: 'Models', index: 3, keywords: 'model catalog search provider category cache fallback' },
    { id: 'power-mode', title: 'Atlas Power Mode', index: 4, keywords: 'smart full cost context tools' },
    { id: 'local-models', title: 'Local Models', index: 5, keywords: 'ollama lm studio base url timeout tool mode' },
    { id: 'mcp', title: 'MCP Servers', index: 6, keywords: 'mcp servers stdio http tools integration' },
    { id: 'agents', title: 'Agents', index: 7, keywords: 'agents directory orchestrator atlas athena prometheus' },
    { id: 'skills', title: 'Skills', index: 8, keywords: 'skills directory manager trigger learned' },
    { id: 'guardrails', title: 'Hooks & Guardrails', index: 9, keywords: 'hooks guardrails dangerous command path safety secret redaction prompt injection lifecycle approval' },
    { id: 'tools', title: 'Tools', index: 10, keywords: 'tools terminal git file web browser todo clarify' },
    { id: 'sessions', title: 'Sessions', index: 11, keywords: 'sessions transcript resume history export' },
    { id: 'compaction', title: 'Context & Compaction', index: 12, keywords: 'context compaction summarizer threshold tokens' },
    { id: 'paths', title: 'Config Paths', index: 13, keywords: 'config paths yaml sessions agents skills' },
    { id: 'commands', title: 'Workflow Commands', index: 14, keywords: 'slash workflow commands routing runtime' },
    { id: 'ship', title: 'Ship & Integrations', index: 15, keywords: 'ship github merge conflict integrations' },
  ] as const;
  const settingsNeedle = settingsSearch.trim().toLowerCase();
  const searchActive = settingsNeedle.length > 0;
  const sectionMatches = (id: string): boolean => {
    if (!searchActive) return true;
    const section = settingsSections.find((item) => item.id === id);
    if (!section) return true;
    return `${section.title} ${section.keywords}`.toLowerCase().includes(settingsNeedle);
  };
  const sectionOpen = (id: string): boolean => searchActive || openSections.has(id);
  const toggleSection = (id: string): void => {
    setOpenSections((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const openAllSections = (): void => setOpenSections(new Set(settingsSections.map((section) => section.id)));
  const collapseAllSections = (): void => setOpenSections(new Set(['general', 'provider-keys', 'models']));
  const defaultModelNeedle = defaultModelSearch.trim().toLowerCase();
  const defaultModelRows = allModels.filter((model) => {
    if (!modelMatchesFilter(model, defaultProviderToModelFilter(settings.defaultProvider))) return false;
    return defaultModelNeedle.length === 0
      || model.id.toLowerCase().includes(defaultModelNeedle)
      || model.label.toLowerCase().includes(defaultModelNeedle)
      || model.providerLabel.toLowerCase().includes(defaultModelNeedle);
  });

  return (
    <section className="settingsView settingsView-showcase">
      <SettingsHeader title="Settings" subtitle="Configure Atlas to fit your workflow." onBack={onBack} onOpenConfig={onOpenConfig} onRefresh={onRefresh} variant="showcase" />
      {notice ? <div className="settingsNotice" role="status">{notice}</div> : null}
      {settingsDetail ? <SettingsDetailPanel detail={settingsDetail} onClose={() => setSettingsDetail(null)} /> : null}
      {authProvider ? (
        <ProviderAuthPanel
          provider={authProvider}
          settings={settings}
          onClose={() => setAuthProvider(null)}
          onStoreSecret={onStoreSecret}
          onClearSecret={onClearSecret}
          onSignInCodex={onSignInCodex}
          onUpdateSettings={onUpdateSettings}
        />
      ) : null}

      <div className="settingsSearchRail">
        <label className="showcaseModelSearch settingsSearchBox">
          <i className="codicon codicon-search" aria-hidden="true" />
          <input
            value={settingsSearch}
            onChange={(event) => setSettingsSearch(event.currentTarget.value)}
            placeholder="Search settings..."
          />
        </label>
        <div className="settingsSectionActions">
          <button type="button" className="showcaseMiniButton" onClick={openAllSections}>Expand all</button>
          <button type="button" className="showcaseMiniButton" onClick={collapseAllSections}>Collapse</button>
        </div>
      </div>
      <nav className="settingsSectionNav" aria-label="Settings sections">
        {settingsSections.map((section) => (
          <button
            key={section.id}
            type="button"
            className={sectionMatches(section.id) ? '' : 'isHiddenBySearch'}
            onClick={() => {
              if (!openSections.has(section.id)) toggleSection(section.id);
              document.querySelector(`[data-settings-section="${section.id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }}
          >
            {section.index}. {section.title}
          </button>
        ))}
      </nav>

      <div className="settingsGrid settingsGrid-showcase">
        <SettingsCard title="General" index={1} variant="showcase" sectionId="general" hidden={!sectionMatches('general')} collapsible open={sectionOpen('general')} onToggle={() => toggleSection('general')}>
          <div className="showcaseForm">
            <label className="showcaseField">
              <span>Default provider</span>
              <select
                className="showcaseSelect showcaseNativeSelect"
                value={settings.defaultProvider}
                onChange={(event) => onUpdateSettings({ defaultProvider: event.currentTarget.value as NonNullable<SafeSettingsUpdate['defaultProvider']> })}
              >
                {defaultProviders.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="showcaseField">
              <span>Default model</span>
              <button
                type="button"
                className="showcaseSelect"
                onClick={() => {
                  setModelProviderFilter(defaultProviderToModelFilter(settings.defaultProvider));
                  setDefaultModelSearch('');
                  setDefaultModelPickerOpen((current) => !current);
                  onRefreshModels();
                }}
                aria-expanded={defaultModelPickerOpen}
              >
                <i className="codicon codicon-source-control" aria-hidden="true" />
                <strong>{settings.defaultModel}</strong>
                <i className={`codicon codicon-chevron-${defaultModelPickerOpen ? 'up' : 'down'}`} aria-hidden="true" />
              </button>
            </label>
            {defaultModelPickerOpen ? (
              <div className="showcaseDropdownPanel">
                <div className="showcaseDropdownHeader">
                  <strong>{modelsLoading ? 'Loading models...' : 'Choose default model'}</strong>
                  <button type="button" onClick={() => setDefaultModelPickerOpen(false)} aria-label="Close model dropdown">
                    <i className="codicon codicon-close" aria-hidden="true" />
                  </button>
                </div>
                <label className="showcaseModelSearch showcaseDropdownSearch">
                  <i className="codicon codicon-search" aria-hidden="true" />
                  <input
                    value={defaultModelSearch}
                    onChange={(event) => setDefaultModelSearch(event.currentTarget.value)}
                    placeholder="Search this provider..."
                    autoFocus
                  />
                </label>
                <div className="showcaseDropdownList">
                  {defaultModelRows.length > 0 ? (
                    defaultModelRows
                      .map((model) => (
                        <button
                          key={`${model.provider}:${model.id}`}
                          type="button"
                          className={model.configuredDefault ? 'isSelected' : ''}
                          onClick={() => {
                            onSelectModel(model);
                            setDefaultModelPickerOpen(false);
                          }}
                        >
                          <span>{model.id}</span>
                          <small>{model.providerLabel} · {model.promptCacheLabel}</small>
                        </button>
                      ))
                  ) : (
                    <p>{modelsLoading ? 'Pulling catalog rows from configured providers.' : 'No rows for this provider yet. Check auth, then refresh the catalog.'}</p>
                  )}
                </div>
              </div>
            ) : null}
            <div className="showcaseField">
              <span>Hosted power mode</span>
              <div className="showcaseSegment" aria-label="Hosted power mode">
                <button type="button" className={settings.atlasMode === 'smart' ? 'isActive' : ''} onClick={() => onUpdateSettings({ atlasMode: 'smart' })}>Smart</button>
                <button type="button" className={settings.atlasMode === 'full' ? 'isActive' : ''} onClick={() => onUpdateSettings({ atlasMode: 'full' })}>Full</button>
              </div>
            </div>
            <div className="showcaseField">
              <span>Local power mode</span>
              <div className="showcaseSegment" aria-label="Local power mode">
                <button type="button" className={settings.vscodePowerMode === 'lite' ? 'isActive' : ''} onClick={() => onUpdateSettings({ vscodePowerMode: 'lite' })}>Lite</button>
                <button type="button" className={settings.vscodePowerMode === 'hybrid' ? 'isActive' : ''} onClick={() => onUpdateSettings({ vscodePowerMode: 'hybrid' })}>Hybrid</button>
                <button type="button" className={settings.vscodePowerMode === 'full' ? 'isActive' : ''} onClick={() => onUpdateSettings({ vscodePowerMode: 'full' })}>Full</button>
              </div>
            </div>
            <div className="showcaseToggleRow">
              <div>
                <strong>Model catalog refresh</strong>
                <span>Reloads configured provider catalogs and local model discovery.</span>
              </div>
              <button type="button" className="showcaseIconOnlyButton" onClick={onRefreshModels} title="Refresh model catalog" aria-label="Refresh model catalog">
                <i className={`codicon codicon-${modelsLoading ? 'sync spin' : 'refresh'}`} aria-hidden="true" />
              </button>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard title="Provider Keys" index={2} variant="showcase" sectionId="provider-keys" hidden={!sectionMatches('provider-keys')} collapsible open={sectionOpen('provider-keys')} onToggle={() => toggleSection('provider-keys')}>
          <div className="showcaseProviderList">
            {providerRows.map((provider) => (
              <ShowcaseProviderRow
                key={provider.id}
                name={provider.name}
                detail={provider.detail}
                icon={provider.icon}
                configured={provider.configured}
                active={status.providerName === provider.id || (provider.id === 'openai-codex' && status.providerName === 'openai')}
                onOpenConfig={() => setAuthProvider(provider.authProvider)}
                secretKey={provider.secretKey}
                onClearSecret={onClearSecret}
              />
            ))}
          </div>
        </SettingsCard>

        <SettingsCard title="Models" index={3} variant="showcase" sectionId="models" hidden={!sectionMatches('models')} collapsible open={sectionOpen('models')} onToggle={() => toggleSection('models')}>
          {modelsLoading ? (
            <div className="showcaseLoadingLine" role="status">
              <i className="codicon codicon-sync spin" aria-hidden="true" />
              Refreshing model catalog...
            </div>
          ) : null}
          {models?.diagnostics && models.diagnostics.length > 0 ? (
            <div className="modelDiagnosticGrid">
              {models.diagnostics.map((diagnostic) => (
                <button
                  key={diagnostic.provider}
                  type="button"
                  className={`modelDiagnostic modelDiagnostic-${diagnostic.status}`}
                  title={diagnostic.message}
                  onClick={() => setModelProviderFilter(diagnostic.provider)}
                >
                  <span>{diagnostic.providerLabel}</span>
                  <strong>{diagnostic.status === 'loaded' ? diagnostic.count : diagnostic.status}</strong>
                </button>
              ))}
            </div>
          ) : null}
          <div className="showcaseModelSearch">
            <i className="codicon codicon-search" aria-hidden="true" />
            <input value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="Search models..." />
          </div>
          <div className="showcaseTabs" aria-label="Model providers">
            {modelProviderTabs.map((tab) => (
              <button
                key={tab.filter}
                type="button"
                className={modelProviderFilter === tab.filter ? 'isActive' : ''}
                onClick={() => setModelProviderFilter(tab.filter)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {filteredModels.length > 0 ? (
            <div className="showcaseModelList" role="listbox" aria-label="Atlas models">
              {filteredModels.map((model) => (
                <button
                  key={`${model.provider}:${model.id}`}
                  type="button"
                  className={`showcaseModelRow ${model.active ? 'isSelected' : ''}`}
                  role="option"
                  aria-selected={model.active}
                  onClick={() => onSelectModel(model)}
                >
                  <span>{model.id}</span>
                  {model.active ? <i className="codicon codicon-check" aria-hidden="true" /> : <i className="codicon codicon-circle-outline" aria-hidden="true" />}
                  <small className={model.promptCacheLabel.includes('yes') ? 'isCacheYes' : model.promptCacheLabel.includes('unknown') ? 'isCacheUnknown' : 'isCacheNo'}>
                    {model.promptCacheLabel}
                  </small>
                  <small className="isDefault">
                    <i className="codicon codicon-zap" aria-hidden="true" />
                    {model.configuredDefault ? 'Default' : model.providerLabel}
                  </small>
                  {model.contextWindow ? <small>{model.contextWindow.toLocaleString()} ctx</small> : null}
                  {model.custom ? <small>custom</small> : null}
                  {model.fallback ? <small>fallback</small> : null}
                </button>
              ))}
            </div>
          ) : (
            <div className="showcaseModelEmpty">No models matched this category. Configure a provider key or refresh the catalog.</div>
          )}
          <button type="button" className="showcaseLinkRow" onClick={onOpenConfig}>
            <span>Manage fallback models</span>
            <i className="codicon codicon-chevron-right" aria-hidden="true" />
          </button>
        </SettingsCard>

        <SettingsCard title="Atlas Power Mode" index={4} variant="showcase" sectionId="power-mode" hidden={!sectionMatches('power-mode')} collapsible open={sectionOpen('power-mode')} onToggle={() => toggleSection('power-mode')}>
          <div className="showcasePowerList" aria-label="Hosted power modes">
            <button type="button" className={`showcasePowerOption ${settings.atlasMode === 'smart' ? 'isActive' : ''}`} onClick={() => onUpdateSettings({ atlasMode: 'smart' })}>
              <span className="showcaseRadio" />
              <div>
                <strong>Atlas Smart Mode <StatusPill tone={settings.atlasMode === 'smart' ? 'active' : 'muted'} label={settings.atlasMode === 'smart' ? 'Active' : 'Available'} /></strong>
                <small>Cost-aware daily mode. Prefers cache-friendly model choices.</small>
              </div>
            </button>
            <button type="button" className={`showcasePowerOption ${settings.atlasMode === 'full' ? 'isActive' : ''}`} onClick={() => onUpdateSettings({ atlasMode: 'full' })}>
              <span className="showcaseRadio" />
              <div>
                <strong>Atlas Power Full <StatusPill tone={settings.atlasMode === 'full' ? 'active' : 'muted'} label={settings.atlasMode === 'full' ? 'Active' : 'Available'} /></strong>
                <small>Maximum context, tools, MCP, hooks, and predictable behavior.</small>
              </div>
            </button>
          </div>
          <div className="showcasePowerList" aria-label="Local power modes" style={{ marginTop: 8 }}>
            <button type="button" className={`showcasePowerOption ${settings.vscodePowerMode === 'lite' ? 'isActive' : ''}`} onClick={() => onUpdateSettings({ vscodePowerMode: 'lite' })}>
              <span className="showcaseRadio" />
              <div>
                <strong>Atlas Lite <StatusPill tone={settings.vscodePowerMode === 'lite' ? 'active' : 'muted'} label={settings.vscodePowerMode === 'lite' ? 'Active' : 'Available'} /></strong>
                <small>Fastest responses, lowest token cost, ideal for local models and simple tasks.</small>
              </div>
            </button>
            <button type="button" className={`showcasePowerOption ${settings.vscodePowerMode === 'hybrid' ? 'isActive' : ''}`} onClick={() => onUpdateSettings({ vscodePowerMode: 'hybrid' })}>
              <span className="showcaseRadio" />
              <div>
                <strong>Atlas Hybrid <StatusPill tone={settings.vscodePowerMode === 'hybrid' ? 'active' : 'muted'} label={settings.vscodePowerMode === 'hybrid' ? 'Active' : 'Available'} /></strong>
                <small>Balanced tool surface for daily local work.</small>
              </div>
            </button>
            <button type="button" className={`showcasePowerOption ${settings.vscodePowerMode === 'full' ? 'isActive' : ''}`} onClick={() => onUpdateSettings({ vscodePowerMode: 'full' })}>
              <span className="showcaseRadio" />
              <div>
                <strong>Atlas Local Full <StatusPill tone={settings.vscodePowerMode === 'full' ? 'active' : 'muted'} label={settings.vscodePowerMode === 'full' ? 'Active' : 'Available'} /></strong>
                <small>Maximum context, tools, MCP, hooks for local models.</small>
              </div>
            </button>
          </div>
          <p className="showcaseMutedLine">Model rows show cache: <span className="isCacheYes">yes</span> / <span className="isCacheUnknown">unknown</span> / <span className="isCacheNo">no</span>.</p>
        </SettingsCard>

        <SettingsCard title="Local Models" index={5} variant="showcase" sectionId="local-models" hidden={!sectionMatches('local-models')} collapsible open={sectionOpen('local-models')} onToggle={() => toggleSection('local-models')}>
          <div className="showcaseForm">
            <label className="showcaseField">
              <span>Base URL</span>
              <input
                className="showcaseInput showcaseTextInput"
                value={localBaseUrlDraft}
                onChange={(event) => setLocalBaseUrlDraft(event.currentTarget.value)}
                onBlur={() => {
                  const value = localBaseUrlDraft.trim();
                  if (value && value !== settings.providers.local.baseUrl) onUpdateSettings({ localBaseUrl: value });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
            </label>
            <div className="showcaseToggleLine">
              <span>Auto-detect local models</span>
              <button
                type="button"
                className={`showcaseSwitch ${settings.providers.local.autoDetect ? 'isOn' : ''}`}
                aria-pressed={settings.providers.local.autoDetect}
                aria-label="Toggle local model auto-detect"
                onClick={() => onUpdateSettings({ localAutoDetect: !settings.providers.local.autoDetect })}
              />
            </div>
            <div className="showcaseField">
              <span>Tool mode</span>
              <div className="showcaseSegment" aria-label="Local tool modes">
                {(['lite', 'hybrid', 'full'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={settings.providers.local.toolMode === mode ? 'isActive' : ''}
                    onClick={() => onUpdateSettings({ localToolMode: mode })}
                  >
                    {mode === 'full' ? 'Full Atlas' : titleCase(mode)}
                  </button>
                ))}
              </div>
            </div>
            <label className="showcaseField">
              <span>Request timeout</span>
              <span className="showcaseInput hasSuffix">
                <input
                  className="showcaseInlineNumber"
                  value={localTimeoutDraft}
                  inputMode="numeric"
                  onChange={(event) => setLocalTimeoutDraft(event.currentTarget.value.replace(/\D+/g, ''))}
                  onBlur={() => {
                    const timeout = Number.parseInt(localTimeoutDraft, 10);
                    if (Number.isSafeInteger(timeout) && timeout > 0 && timeout !== settings.providers.local.requestTimeoutMs) {
                      onUpdateSettings({ localRequestTimeoutMs: timeout });
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
                <small>ms</small>
              </span>
            </label>
            <p className="showcaseMutedLine">Supports Ollama, LM Studio, vLLM, and llama.cpp via OpenAI-compatible /v1 API.</p>
          </div>
        </SettingsCard>

        <SettingsCard title="MCP Servers" index={6} variant="showcase" sectionId="mcp" hidden={!sectionMatches('mcp')} collapsible open={sectionOpen('mcp')} onToggle={() => toggleSection('mcp')}>
          <p className="showcaseIntro">Built-in support for stdio and Streamable HTTP MCP servers.</p>
          <div className="showcaseMcpSummary">
            <span><i className="codicon codicon-plug" aria-hidden="true" /></span>
            <div>
              <strong>{settings.mcp.servers} servers configured</strong>
              <small>{settings.mcp.active} active • {settings.mcp.disabled} disabled</small>
            </div>
          </div>
          <button type="button" className="showcaseActionButton" onClick={onManageMcp}>
            Manage MCP Servers
            <i className="codicon codicon-chevron-right" aria-hidden="true" />
          </button>
          <button type="button" className="showcaseTextLink" onClick={onOpenConfig}>Edit mcp.servers in config.yaml</button>
        </SettingsCard>

        <SettingsCard title="Agents" index={7} variant="showcase" sectionId="agents" hidden={!sectionMatches('agents')} collapsible open={sectionOpen('agents')} onToggle={() => toggleSection('agents')}>
          <div className="showcaseAgentList">
            {agentRows.map((agent) => (
              <div key={agent.name} className={`showcaseAgentRow ${agent.active ? 'isActive' : ''}`}>
                <span className="showcaseAgentGlyph">{agentGlyph(agent.name)}</span>
                <strong>{titleCase(agent.name)}</strong>
                <StatusPill tone={agent.active ? 'active' : agent.switchable ? 'ok' : 'muted'} label={agent.active ? 'Active' : agent.role} />
                {agent.active ? <span className="showcaseAgentDot" aria-hidden="true" /> : null}
              </div>
            ))}
          </div>
          <div className="showcasePathGrid">
            <PathField label="Agents directory" value={settings.directories.agents} onOpen={onOpenConfig} />
            <PathField label="Project overrides" value="<repo>/.atlas/agents/" onOpen={onOpenConfig} />
          </div>
          <button type="button" className="showcaseActionButton" onClick={onManageAgents}>
            <i className="codicon codicon-go-to-file" aria-hidden="true" />
            Manage agents
          </button>
          <p className="showcaseMutedLine">Active agent is selected from project state.</p>
        </SettingsCard>

        <SettingsCard title="Skills" index={8} variant="showcase" sectionId="skills" hidden={!sectionMatches('skills')} collapsible open={sectionOpen('skills')} onToggle={() => toggleSection('skills')}>
          <PathField label="Skills directory" value={settings.directories.skills} onOpen={onOpenConfig} />
          <div className="showcaseToggleList">
            {([
              ['Installed skills', 'on demand'],
              ['Trigger matching', 'automatic'],
              ['Disabled skills', 'frontmatter'],
              ['Learned skills', 'managed'],
            ] as const).map(([label, state]) => (
              <div key={label} className="showcaseToggleLine">
                <span>{label}</span>
                <StatusPill tone={state === 'managed' ? 'muted' : 'active'} label={state} />
              </div>
            ))}
          </div>
          <button type="button" className="showcaseActionButton isFull" onClick={() => onUseCommand('/skills ')}>
            <i className="codicon codicon-go-to-file" aria-hidden="true" />
            Open Skills Manager
          </button>
          <p className="showcaseMutedLine">Skills are loaded on demand when triggered by context.</p>
        </SettingsCard>

        <SettingsCard title="Hooks & Guardrails" index={9} variant="showcase" sectionId="guardrails" hidden={!sectionMatches('guardrails')} collapsible open={sectionOpen('guardrails')} onToggle={() => toggleSection('guardrails')}>
          <div className="showcaseToggleLine">
            <span>Guardrails master switch</span>
            <button
              type="button"
              className={`showcaseSwitch ${settings.guardrails.enabled ? 'isOn' : ''}`}
              aria-pressed={settings.guardrails.enabled}
              aria-label="Toggle guardrails"
              onClick={() => onUpdateSettings({ guardrailsEnabled: !settings.guardrails.enabled })}
            />
          </div>
          <div className="showcaseHookGrid">
            <span>Lifecycle hooks</span>
            <div>
              {lifecycleHooks.map((hook) => (
                <button
                  key={hook}
                  type="button"
                  className="showcaseHookToken"
                  onClick={() => setSettingsDetail(hookDetail(hook))}
                >
                  {hook}
                </button>
              ))}
            </div>
          </div>
          <div className="showcaseApprovalGrid">
            {approvalRows.map((row) => (
              <label key={row.label}>
                <span>{row.label}:</span>
                <button type="button" onClick={() => setSettingsDetail(row.detail)}>
                  {row.value}
                  <i className="codicon codicon-info" aria-hidden="true" />
                </button>
              </label>
            ))}
          </div>
          <div className="showcaseGuardrailGrid">
            {guardrailItems.map((item) => (
              <button
                key={item.label}
                type="button"
                className={`toggleToken ${item.enabled ? 'isOn' : ''}`}
                onClick={() => setSettingsDetail({
                  title: item.label,
                  description: item.description,
                  rows: [
                    { label: 'Current state', value: item.enabled ? 'enabled' : 'disabled' },
                    { label: 'Config field', value: guardrailConfigField(item.updateKey) },
                  ],
                  action: {
                    label: item.enabled ? 'Disable guardrail' : 'Enable guardrail',
                    run: () => onUpdateSettings(guardrailUpdate(item.updateKey, !item.enabled)),
                  },
                })}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="showcaseBlocked">
            <i className="codicon codicon-warning" aria-hidden="true" />
            <span>blocked by hook:</span>
            <code>rm -rf</code>
          </div>
        </SettingsCard>

        <SettingsCard title="Tools" index={10} variant="showcase" sectionId="tools" hidden={!sectionMatches('tools')} collapsible open={sectionOpen('tools')} onToggle={() => toggleSection('tools')}>
          <p className="showcaseIntro">Enabled core tools</p>
          <div className="showcaseToolGrid">
            {toolRows.map((tool) => (
              <button
                key={tool.name}
                type="button"
                className="showcaseToolToken"
                onClick={() => setSettingsDetail({
                  title: tool.name,
                  description: tool.description,
                  rows: [
                    { label: 'Approval', value: tool.approval },
                    { label: 'Registry', value: 'built-in' },
                  ],
                })}
              >
                <i className={`codicon codicon-${toolIcon(tool.name)}`} aria-hidden="true" />
                {tool.name}
              </button>
            ))}
          </div>
          <p className="showcaseMutedLine">Tool execution is cancellable and validated by schema.</p>
        </SettingsCard>

        <SettingsCard title="Sessions" index={11} variant="showcase" sectionId="sessions" hidden={!sectionMatches('sessions')} collapsible open={sectionOpen('sessions')} onToggle={() => toggleSection('sessions')}>
          <div className="showcaseToggleList isPlain">
            <div className="showcaseToggleLine"><span>Save transcripts</span><StatusPill tone="active" label="active" /></div>
            <div className="showcaseToggleLine"><span>Active session marker</span><StatusPill tone={sessions?.activeSessionId ? 'active' : 'muted'} label={sessions?.activeSessionId ? 'set' : 'none'} /></div>
            <div className="showcaseToggleLine"><span>Stored sessions</span><StatusPill tone={sessionCount > 0 ? 'ok' : 'muted'} label={sessionCount.toLocaleString()} /></div>
          </div>
          <p className="showcaseMutedLine">Resume older work from {sessionCount.toLocaleString()} saved session{sessionCount === 1 ? '' : 's'}.</p>
          <div className="showcaseButtonRow">
            <button type="button" className="showcaseActionButton" onClick={onManageSessions}><i className="codicon codicon-folder-opened" aria-hidden="true" />Manage sessions</button>
            <button type="button" className="showcaseDangerButton" onClick={() => onUseCommand('/sessions delete ')}><i className="codicon codicon-trash" aria-hidden="true" />Delete all...</button>
            <button type="button" className="showcaseActionButton" onClick={() => onUseCommand('/history ')}><i className="codicon codicon-cloud-download" aria-hidden="true" />Export transcript</button>
          </div>
        </SettingsCard>

        <SettingsCard title="Context & Compaction" index={12} variant="showcase" sectionId="compaction" hidden={!sectionMatches('compaction')} collapsible open={sectionOpen('compaction')} onToggle={() => toggleSection('compaction')}>
          <div className="showcaseForm">
            <label className="showcaseField">
              <span>Context warning threshold</span>
              <select
                className="showcaseSelect showcaseNativeSelect"
                value={String(settings.compaction.threshold)}
                onChange={(event) => onUpdateSettings({ compactionThreshold: Number.parseFloat(event.currentTarget.value) })}
              >
                {compactionThresholdOptions.includes(settings.compaction.threshold as (typeof compactionThresholdOptions)[number]) ? null : (
                  <option value={String(settings.compaction.threshold)}>{Math.round(settings.compaction.threshold * 100)}%</option>
                )}
                {compactionThresholdOptions.map((threshold) => (
                  <option key={threshold} value={String(threshold)}>{Math.round(threshold * 100)}%</option>
                ))}
              </select>
            </label>
            <div className="showcaseToggleLine">
              <span>Auto-compact older turns</span>
              <button
                type="button"
                className={`showcaseSwitch ${settings.compaction.enabled ? 'isOn' : ''}`}
                aria-pressed={settings.compaction.enabled}
                aria-label="Toggle auto-compaction"
                onClick={() => onUpdateSettings({ compactionEnabled: !settings.compaction.enabled })}
              />
            </div>
            <label className="showcaseField">
              <span>Cheap summarizer model</span>
              <span className="showcaseInput hasSuffix">
                <input
                  className="showcaseInlineText"
                  value={compactionModelDraft}
                  placeholder="auto"
                  onChange={(event) => setCompactionModelDraft(event.currentTarget.value)}
                  onBlur={() => {
                    const value = compactionModelDraft.trim();
                    const current = settings.compaction.model ?? settings.routerModel ?? '';
                    if (value !== current) onUpdateSettings({ compactionModel: value.length > 0 ? value : null });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
                <button type="button" className="showcaseMiniButton" onClick={() => onUpdateSettings({ compactionModel: null })}>auto</button>
              </span>
            </label>
            <label className="showcaseField">
              <span>Context tokens</span>
              <span className="showcaseInput hasSuffix">
                <input
                  className="showcaseInlineNumber"
                  value={compactionContextDraft}
                  inputMode="numeric"
                  onChange={(event) => setCompactionContextDraft(event.currentTarget.value.replace(/\D+/g, ''))}
                  onBlur={() => {
                    const contextTokens = Number.parseInt(compactionContextDraft, 10);
                    if (Number.isSafeInteger(contextTokens) && contextTokens > 0 && contextTokens !== settings.compaction.contextTokens) {
                      onUpdateSettings({ compactionContextTokens: contextTokens });
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
                <small>tokens</small>
              </span>
            </label>
            <p className="showcaseMutedLine">Older turns are summarized when the active model nears its context limit.</p>
          </div>
        </SettingsCard>

        <SettingsCard title="Config Paths" index={13} variant="showcase" wide sectionId="paths" hidden={!sectionMatches('paths')} collapsible open={sectionOpen('paths')} onToggle={() => toggleSection('paths')}>
          <div className="showcasePathMatrix">
            <PathField label="User config" value={settings.configPath} onOpen={onOpenConfig} />
            <PathField label="Sessions" value="~/.atlas/sessions" onOpen={onManageSessions} />
            <PathField label="Agents" value={settings.directories.agents} onOpen={onManageAgents} />
            <PathField label="Skills" value={settings.directories.skills} onOpen={() => onUseCommand('/skills ')} />
            <PathField label="MCP servers" value="config.yaml -> mcp.servers" onOpen={onOpenConfig} />
          </div>
        </SettingsCard>

        <SettingsCard title="Workflow Commands" index={14} variant="showcase" sectionId="commands" hidden={!sectionMatches('commands')} collapsible open={sectionOpen('commands')} onToggle={() => toggleSection('commands')}>
          <div className="showcaseCommandMap">
            {slashCommandGroups.map((group) => (
              <section key={group} className="showcaseCommandGroup" aria-label={`${group} commands`}>
                <h3>{group}</h3>
                <div>
                  {slashCommands.filter((command) => command.group === group).map((command) => (
                    <button
                      key={command.name}
                      type="button"
                      className="showcaseCommandChip"
                      title={command.summary}
                      onClick={() => onUseCommand(`/${command.name} `)}
                    >
                      /{command.name}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </SettingsCard>

        <SettingsCard title="Ship & Integrations" index={15} variant="showcase" sectionId="ship" hidden={!sectionMatches('ship')} collapsible open={sectionOpen('ship')} onToggle={() => toggleSection('ship')}>
          <div className="showcaseForm">
            <label className="showcaseField">
              <span>Auto-merge strategy</span>
              <div className="showcaseSegment showcaseSegment-four" aria-label="Ship conflict strategy">
                {(['abort', 'ours', 'theirs', 'ai'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={settings.ship.autoResolve === mode ? 'isActive' : ''}
                    onClick={() => onUpdateSettings({ shipAutoResolve: mode })}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </label>
            <div className="showcaseToggleLine">
              <span>Prompt on conflict</span>
              <button
                type="button"
                className={`showcaseSwitch ${settings.ship.promptOnConflict ? 'isOn' : ''}`}
                aria-pressed={settings.ship.promptOnConflict}
                aria-label="Toggle prompt on conflict"
                onClick={() => onUpdateSettings({ promptOnConflict: !settings.ship.promptOnConflict })}
              />
            </div>
            <PathField label="GitHub login" value={settings.github.login ?? 'not set'} onOpen={() => onPromptSecret('github.token')} />
            <PathField label="VS Code setup" value={settings.commands.vscodeSetup} onOpen={onOpenConfig} />
          </div>
        </SettingsCard>
      </div>

      <footer className="settingsFooter settingsFooter-showcase">
        <button type="button" className="settingsSecondaryButton" onClick={onOpenConfig}>
          <i className="codicon codicon-file-code" aria-hidden="true" />
          Open config.yaml
        </button>
        <button type="button" className="settingsSecondaryButton" onClick={onRefresh}>
          <i className="codicon codicon-history" aria-hidden="true" />
          Refresh settings
        </button>
        <button type="button" className="settingsPrimaryButton" onClick={onRefreshModels}>
          <i className="codicon codicon-refresh" aria-hidden="true" />
          Refresh models
        </button>
      </footer>
    </section>
  );
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function defaultProviderToModelFilter(provider: SettingsSummary['defaultProvider']): ModelProviderFilter {
  return provider;
}

function modelMatchesFilter(model: ModelSummary, filter: ModelProviderFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'opencode') return model.provider === 'opencode-zen' || model.provider === 'opencode-go';
  return model.provider === filter;
}

function countModelsForFilter(models: readonly ModelSummary[], filter: ModelProviderFilter): number {
  return models.filter((model) => modelMatchesFilter(model, filter)).length;
}

function hookDetail(hook: string): SettingsDetail {
  const descriptions: Readonly<Record<string, string>> = {
    sessionStart: 'Runs when an Atlas session starts. Good for seeding context, checking workspace state, or preparing provider/runtime defaults.',
    beforeMessage: 'Runs before a user message is sent into the agent loop. Useful for validating context and stopping bad requests early.',
    afterMessage: 'Runs after an assistant message. Useful for audits, transcript handling, and warning generation.',
    beforeTool: 'Runs before tool execution. This is where path safety, dangerous command blocking, and approval preflight checks protect the workspace.',
    afterTool: 'Runs after a tool finishes. Useful for redaction, prompt-injection warnings, and result auditing.',
    sessionEnd: 'Runs when a session closes or is persisted. Useful for transcript storage and cleanup.',
  };
  return {
    title: hook,
    description: descriptions[hook] ?? 'Atlas lifecycle hook.',
    rows: [
      { label: 'Type', value: 'lifecycle hook' },
      { label: 'Configured in', value: 'Atlas runtime hook registry' },
    ],
  };
}

function guardrailConfigField(key: GuardrailUpdateKey): string {
  switch (key) {
    case 'guardrailDangerousCommand':
      return 'guardrails.dangerousCommand';
    case 'guardrailPathSafety':
      return 'guardrails.pathSafety';
    case 'guardrailSecretRedaction':
      return 'guardrails.secretRedaction';
    case 'guardrailPromptInjectionDetector':
      return 'guardrails.promptInjectionDetector';
    case 'guardrailDiscoverGuardrails':
      return 'guardrails.discoverGuardrails';
    case 'guardrailProgressTracker':
      return 'guardrails.progressTracker';
  }
}

function guardrailUpdate(key: GuardrailUpdateKey, enabled: boolean): SafeSettingsUpdate {
  switch (key) {
    case 'guardrailDangerousCommand':
      return { guardrailDangerousCommand: enabled };
    case 'guardrailPathSafety':
      return { guardrailPathSafety: enabled };
    case 'guardrailSecretRedaction':
      return { guardrailSecretRedaction: enabled };
    case 'guardrailPromptInjectionDetector':
      return { guardrailPromptInjectionDetector: enabled };
    case 'guardrailDiscoverGuardrails':
      return { guardrailDiscoverGuardrails: enabled };
    case 'guardrailProgressTracker':
      return { guardrailProgressTracker: enabled };
  }
}

function toolIcon(name: string): string {
  if (/read|template|checklist|context_show|plan_show/.test(name)) return 'file';
  if (/write|edit|create|update|render|set|note|finalize/.test(name)) return 'edit';
  if (/terminal/.test(name)) return 'terminal';
  if (/git|gh/.test(name)) return 'source-control';
  if (/web|browser/.test(name)) return 'globe';
  if (/todo|plan|ship|story|handoff/.test(name)) return 'checklist';
  if (/clarify|question/.test(name)) return 'question';
  if (/delegate/.test(name)) return 'organization';
  return 'tools';
}

function SettingsDetailPanel({
  detail,
  onClose,
}: {
  readonly detail: SettingsDetail;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <section className="settingsDetailPanel" aria-live="polite">
      <header>
        <div>
          <h2>{detail.title}</h2>
          <p>{detail.description}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close details">
          <i className="codicon codicon-close" aria-hidden="true" />
        </button>
      </header>
      {detail.rows ? (
        <div className="settingsDetailRows">
          {detail.rows.map((row) => (
            <div key={row.label}>
              <span>{row.label}</span>
              <strong>{row.value}</strong>
            </div>
          ))}
        </div>
      ) : null}
      {detail.action ? (
        <button
          type="button"
          className="showcaseActionButton settingsDetailAction"
          onClick={() => {
            detail.action?.run();
            onClose();
          }}
        >
          {detail.action.label}
        </button>
      ) : null}
    </section>
  );
}

function ProviderAuthPanel({
  provider,
  settings,
  onClose,
  onStoreSecret,
  onClearSecret,
  onSignInCodex,
  onUpdateSettings,
}: {
  readonly provider: AuthProviderId;
  readonly settings: SettingsSummary;
  readonly onClose: () => void;
  readonly onStoreSecret: (key: PromptSecretKey, value: string) => void;
  readonly onClearSecret: (key: PromptSecretKey) => void;
  readonly onSignInCodex: () => void;
  readonly onUpdateSettings: (update: SafeSettingsUpdate) => void;
}): ReactElement {
  const [secretDraft, setSecretDraft] = useState('');
  const meta = authProviderMeta(provider, settings);

  const storeSecret = (key: PromptSecretKey): void => {
    const value = secretDraft.trim();
    if (!value) return;
    onStoreSecret(key, value);
    setSecretDraft('');
  };

  return (
    <section className="settingsSidePanel" aria-live="polite">
      <header>
        <div>
          <h2>{meta.title}</h2>
          <p>{meta.description}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close provider auth">
          <i className="codicon codicon-close" aria-hidden="true" />
        </button>
      </header>

      {provider === 'openai' ? (
        <>
          <div className="authModeBlock">
            <span>OpenAI auth mode</span>
            <div className="showcaseSegment showcaseSegment-three" aria-label="OpenAI auth mode">
              {(['auto', 'apiKey', 'oauth'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={settings.providers.openaiCodex.authMode === mode ? 'isActive' : ''}
                  onClick={() => onUpdateSettings({ openaiAuthMode: mode })}
                >
                  {mode === 'apiKey' ? 'API key' : mode === 'oauth' ? 'OAuth' : 'Auto'}
                </button>
              ))}
            </div>
          </div>
          <SecretEditor
            label="OpenAI API key"
            configured={settings.providers.openaiCodex.apiKeyConfigured}
            value={secretDraft}
            onChange={setSecretDraft}
            onStore={() => storeSecret('openai.apiKey')}
            onClear={() => onClearSecret('openai.apiKey')}
          />
          <div className="authOauthBox">
            <div>
              <strong>ChatGPT / Codex OAuth</strong>
              <span>{settings.providers.openaiCodex.oauthConfigured ? 'Signed in for Codex-backed models.' : 'Sign in with your ChatGPT account for Codex-backed models.'}</span>
            </div>
            <button type="button" className="showcaseActionButton" onClick={onSignInCodex}>
              <i className="codicon codicon-account" aria-hidden="true" />
              Sign in OAuth
            </button>
          </div>
        </>
      ) : provider === 'anthropic' ? (
        <>
          <SecretEditor
            label="Anthropic API key"
            configured={settings.providers.anthropic.configured}
            value={secretDraft}
            onChange={setSecretDraft}
            onStore={() => storeSecret('anthropic.apiKey')}
            onClear={() => onClearSecret('anthropic.apiKey')}
          />
          <div className="authOauthBox">
            <div>
              <strong>Claude Code OAuth</strong>
              <span>When enabled, Atlas uses existing Claude Code OAuth credentials if no API key is set.</span>
            </div>
            <button
              type="button"
              className={`showcaseSwitch ${settings.providers.anthropic.oauthEnabled ? 'isOn' : ''}`}
              aria-pressed={settings.providers.anthropic.oauthEnabled}
              aria-label="Toggle Claude Code OAuth"
              onClick={() => onUpdateSettings({ anthropicUseClaudeCodeOauth: !settings.providers.anthropic.oauthEnabled })}
            />
          </div>
        </>
      ) : meta.secretKey ? (
        <SecretEditor
          label={meta.secretLabel}
          configured={meta.configured}
          value={secretDraft}
          onChange={setSecretDraft}
          onStore={() => storeSecret(meta.secretKey!)}
          onClear={() => onClearSecret(meta.secretKey!)}
        />
      ) : null}

      <div className="settingsDetailRows">
        {meta.rows.map((row) => (
          <div key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function SecretEditor({
  label,
  configured,
  value,
  onChange,
  onStore,
  onClear,
}: {
  readonly label: string;
  readonly configured: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onStore: () => void;
  readonly onClear: () => void;
}): ReactElement {
  return (
    <div className="secretEditor">
      <div className="secretEditorHeader">
        <strong>{label}</strong>
        <StatusPill tone={configured ? 'ok' : 'muted'} label={configured ? 'Stored' : 'Not set'} />
      </div>
      <label className="showcaseInput secretInput">
        <i className="codicon codicon-key" aria-hidden="true" />
        <input
          value={value}
          type="password"
          autoComplete="off"
          placeholder={configured ? 'Paste a replacement key...' : 'Paste key...'}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onStore();
          }}
        />
      </label>
      <div className="showcaseButtonRow">
        <button type="button" className="showcaseActionButton" onClick={onStore} disabled={value.trim().length === 0}>
          <i className="codicon codicon-save" aria-hidden="true" />
          Store key
        </button>
        {configured ? (
          <button type="button" className="showcaseDangerButton" onClick={onClear}>
            <i className="codicon codicon-trash" aria-hidden="true" />
            Clear
          </button>
        ) : null}
      </div>
      <p className="showcaseMutedLine">The key is sent once to the extension host and stored in VS Code SecretStorage. It is not written to config.yaml.</p>
    </div>
  );
}

function authProviderMeta(provider: AuthProviderId, settings: SettingsSummary): {
  readonly title: string;
  readonly description: string;
  readonly secretKey: PromptSecretKey | null;
  readonly secretLabel: string;
  readonly configured: boolean;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
} {
  switch (provider) {
    case 'openrouter':
      return {
        title: 'OpenRouter Auth',
        description: 'Use an OpenRouter API key for hosted routed models.',
        secretKey: 'openrouter.apiKey',
        secretLabel: 'OpenRouter API key',
        configured: settings.providers.openrouter.configured,
        rows: [
          { label: 'Base URL', value: settings.providers.openrouter.baseUrl },
          { label: 'Fallback keys', value: String(settings.providers.openrouter.fallbackKeys) },
        ],
      };
    case 'anthropic':
      return {
        title: 'Anthropic Auth',
        description: 'Use either an Anthropic API key or Claude Code OAuth credentials.',
        secretKey: 'anthropic.apiKey',
        secretLabel: 'Anthropic API key',
        configured: settings.providers.anthropic.configured,
        rows: [
          { label: 'Base URL', value: settings.providers.anthropic.baseUrl },
          { label: 'Claude Code OAuth', value: settings.providers.anthropic.oauthEnabled ? 'enabled' : 'disabled' },
        ],
      };
    case 'openai':
      return {
        title: 'OpenAI Auth',
        description: 'Use a direct OpenAI API key, ChatGPT/Codex OAuth, or Auto to prefer the API key when present.',
        secretKey: 'openai.apiKey',
        secretLabel: 'OpenAI API key',
        configured: settings.providers.openaiCodex.apiKeyConfigured,
        rows: [
          { label: 'Auth mode', value: settings.providers.openaiCodex.authMode },
          { label: 'OAuth', value: settings.providers.openaiCodex.oauthConfigured ? 'signed in' : 'not signed in' },
          { label: 'Codex base URL', value: settings.providers.openaiCodex.baseUrl },
        ],
      };
    case 'opencode-zen':
      return {
        title: 'OpenCode Zen Auth',
        description: 'Use an OpenCode Zen API key for Zen plan models.',
        secretKey: 'opencode.zen.apiKey',
        secretLabel: 'OpenCode Zen API key',
        configured: settings.providers.opencodeZen.configured,
        rows: [{ label: 'Base URL', value: settings.providers.opencodeZen.baseUrl }],
      };
    case 'opencode-go':
      return {
        title: 'OpenCode Go Auth',
        description: 'Use an OpenCode Go API key for Go plan models.',
        secretKey: 'opencode.go.apiKey',
        secretLabel: 'OpenCode Go API key',
        configured: settings.providers.opencodeGo.configured,
        rows: [{ label: 'Base URL', value: settings.providers.opencodeGo.baseUrl }],
      };
    case 'local':
      return {
        title: 'Local Provider Auth',
        description: 'Optional bearer token for local OpenAI-compatible servers that require auth.',
        secretKey: 'local.apiKey',
        secretLabel: 'Local provider API key',
        configured: settings.providers.local.apiKeyConfigured,
        rows: [{ label: 'Base URL', value: settings.providers.local.baseUrl }],
      };
    case 'github':
      return {
        title: 'GitHub Auth',
        description: 'GitHub token for ship and repository integrations.',
        secretKey: 'github.token',
        secretLabel: 'GitHub token',
        configured: settings.github.configured,
        rows: [{ label: 'Login', value: settings.github.login ?? 'not set' }],
      };
  }
}

function ShowcaseProviderRow({
  name,
  detail,
  icon,
  configured,
  active,
  onOpenConfig,
  secretKey,
  onClearSecret,
}: {
  readonly name: string;
  readonly detail: string;
  readonly icon: string;
  readonly configured: boolean;
  readonly active: boolean;
  readonly onOpenConfig: () => void;
  readonly secretKey: PromptSecretKey | null;
  readonly onClearSecret: (key: PromptSecretKey) => void;
}): ReactElement {
  const edit = (): void => {
    onOpenConfig();
  };
  return (
    <div className={`showcaseProviderRow ${active ? 'isActive' : ''}`}>
      <ProviderGlyph icon={icon} />
      <div>
        <strong>{name}</strong>
        <small>{detail}</small>
      </div>
      <StatusPill tone={configured ? 'ok' : 'muted'} label={configured ? 'Configured' : 'Not set'} />
      {secretKey && configured ? (
        <button type="button" className="showcaseEditButton" onClick={() => onClearSecret(secretKey)}>
          Clear
        </button>
      ) : null}
      <button type="button" className="showcaseEditButton" onClick={edit}>
        Manage
        <i className="codicon codicon-chevron-right" aria-hidden="true" />
      </button>
    </div>
  );
}

function ProviderGlyph({ icon }: { readonly icon: string }): ReactElement {
  if (icon === 'anthropic') return <span className="showcaseProviderGlyph isText">AI</span>;
  if (icon === 'openai') return <span className="showcaseProviderGlyph"><i className="codicon codicon-symbol-misc" aria-hidden="true" /></span>;
  return <span className="showcaseProviderGlyph"><i className={`codicon codicon-${icon}`} aria-hidden="true" /></span>;
}

function PathField({
  label,
  value,
  onOpen,
}: {
  readonly label: string;
  readonly value: string;
  readonly onOpen: () => void;
}): ReactElement {
  return (
    <label className="showcasePathField">
      <span>{label}</span>
      <button type="button" onClick={onOpen}>
        <code>{value}</code>
        <i className="codicon codicon-go-to-file" aria-hidden="true" />
      </button>
    </label>
  );
}

function agentGlyph(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'atlas') return 'AT';
  if (normalized === 'athena') return 'A';
  if (normalized === 'prometheus') return 'P';
  if (normalized === 'hestia') return 'H';
  if (normalized === 'hercules') return 'HC';
  if (normalized === 'nemesis') return 'N';
  if (normalized === 'iris') return 'I';
  return normalized.slice(0, 2).toUpperCase() || 'AG';
}

function McpScreen({
  status,
  notice,
  onBack,
  onRefresh,
  onOpenConfig,
  onSetEnabled,
  onAdd,
  onUpsert,
  onRemove,
}: {
  readonly status: McpStatusResult | null;
  readonly notice: string | null;
  readonly onBack: () => void;
  readonly onRefresh: () => void;
  readonly onOpenConfig: () => void;
  readonly onSetEnabled: (name: string, enabled: boolean) => void;
  readonly onAdd: (name: string) => void;
  readonly onUpsert: (server: McpServerDraft) => void;
  readonly onRemove: (name: string) => void;
}): ReactElement {
  const emptyDraft: McpServerDraft = { name: '', transport: 'stdio', command: '', args: [], enabled: true };
  const [draft, setDraft] = useState<McpServerDraft | null>(null);
  const [argsText, setArgsText] = useState('');
  const startEdit = (server?: McpServerSummary): void => {
    const next = server
      ? {
          name: server.name,
          transport: server.transport,
          ...(server.command ? { command: server.command } : { command: '' }),
          ...(server.url ? { url: server.url } : { url: '' }),
          args: server.args,
          enabled: server.enabled,
        }
      : emptyDraft;
    setDraft(next);
    setArgsText((next.args ?? []).join(' '));
  };
  const submitDraft = (): void => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) return;
    const args = argsText.split(/\s+/).map((item) => item.trim()).filter(Boolean);
    onUpsert({
      name,
      transport: draft.transport,
      enabled: draft.enabled,
      ...(draft.transport === 'stdio' ? { command: (draft.command ?? '').trim(), args } : {}),
      ...(draft.transport === 'http' ? { url: (draft.url ?? '').trim() } : {}),
    });
    setDraft(null);
    setArgsText('');
  };
  return (
    <section className="settingsView settingsView-showcase">
      <SettingsHeader title="MCP" subtitle="Configured servers and curated catalog" onBack={onBack} onOpenConfig={onOpenConfig} onRefresh={onRefresh} variant="showcase" />
      {notice ? <div className="settingsNotice" role="status">{notice}</div> : null}
      {!status ? (
        <div className="settingsLoading">Reading MCP configuration...</div>
      ) : (
        <>
          {draft ? (
            <section className="settingsSidePanel">
              <header>
                <div>
                  <h2>{draft.name ? `Edit ${draft.name}` : 'Add MCP Server'}</h2>
                  <p>Configure a stdio command or Streamable HTTP endpoint without opening config.yaml.</p>
                </div>
                <button type="button" onClick={() => setDraft(null)} aria-label="Close MCP editor">
                  <i className="codicon codicon-close" aria-hidden="true" />
                </button>
              </header>
              <div className="showcaseForm">
                <label className="showcaseField">
                  <span>Name</span>
                  <input className="showcaseInput showcaseTextInput" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} />
                </label>
                <div className="showcaseField">
                  <span>Transport</span>
                  <div className="showcaseSegment" aria-label="MCP transport">
                    {(['stdio', 'http'] as const).map((transport) => (
                      <button key={transport} type="button" className={draft.transport === transport ? 'isActive' : ''} onClick={() => setDraft({ ...draft, transport })}>
                        {transport}
                      </button>
                    ))}
                  </div>
                </div>
                {draft.transport === 'stdio' ? (
                  <>
                    <label className="showcaseField">
                      <span>Command</span>
                      <input className="showcaseInput showcaseTextInput" value={draft.command ?? ''} onChange={(event) => setDraft({ ...draft, command: event.currentTarget.value })} />
                    </label>
                    <label className="showcaseField">
                      <span>Args</span>
                      <input className="showcaseInput showcaseTextInput" value={argsText} onChange={(event) => setArgsText(event.currentTarget.value)} />
                    </label>
                  </>
                ) : (
                  <label className="showcaseField">
                    <span>URL</span>
                    <input className="showcaseInput showcaseTextInput" value={draft.url ?? ''} onChange={(event) => setDraft({ ...draft, url: event.currentTarget.value })} />
                  </label>
                )}
                <div className="showcaseToggleLine">
                  <span>Enabled</span>
                  <button
                    type="button"
                    className={`showcaseSwitch ${draft.enabled ? 'isOn' : ''}`}
                    aria-pressed={draft.enabled}
                    aria-label="Toggle MCP server"
                    onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
                  />
                </div>
                <div className="showcaseButtonRow">
                  <button type="button" className="showcaseActionButton" onClick={submitDraft}>
                    <i className="codicon codicon-save" aria-hidden="true" />
                    Save server
                  </button>
                  <button type="button" className="settingsSecondaryButton" onClick={() => setDraft(null)}>Cancel</button>
                </div>
              </div>
            </section>
          ) : null}
          <div className="settingsGrid settingsGrid-showcase">
            <SettingsCard title="MCP Status" badge={`${status.enabled}/${status.configured} enabled`} index={1} variant="showcase">
              <div className="showcaseStatsGrid">
                <SettingsStat label="Configured" value={status.configured} />
                <SettingsStat label="Enabled" value={status.enabled} />
                <SettingsStat label="Running" value={status.active} />
              </div>
              <SettingsMetric label="Host note" value={status.note} wide />
            </SettingsCard>
            <SettingsCard title="Servers" badge={`${status.servers.length} rows`} index={2} variant="showcase">
              <div className="managerList">
                {status.servers.map((server) => (
                  <div key={server.name} className="managerRow">
                    <div>
                      <span>{server.name}</span>
                      <small>{server.summary}</small>
                    </div>
                    <div className="managerRowMeta">
                      <StatusPill tone={server.status === 'failed' ? 'warn' : server.configured ? 'ok' : 'muted'} label={server.status} />
                      <span>{server.transport}</span>
                    </div>
                    <div className="managerRowActions">
                      {server.configured ? (
                        <>
                          <button type="button" onClick={() => startEdit(server)} title="Edit MCP server" aria-label={`Edit ${server.name}`}>
                            <i className="codicon codicon-edit" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onSetEnabled(server.name, !server.enabled)}
                            title={server.enabled ? 'Disable MCP server' : 'Enable MCP server'}
                            aria-label={`${server.enabled ? 'Disable' : 'Enable'} ${server.name}`}
                          >
                            <i className={`codicon codicon-${server.enabled ? 'debug-pause' : 'debug-start'}`} aria-hidden="true" />
                          </button>
                          <button type="button" onClick={() => onRemove(server.name)} title="Remove MCP server" aria-label={`Remove ${server.name}`}>
                            <i className="codicon codicon-trash" aria-hidden="true" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button type="button" onClick={() => startEdit(server)} title="Customize MCP server" aria-label={`Customize ${server.name}`}>
                            <i className="codicon codicon-edit" aria-hidden="true" />
                          </button>
                          <button type="button" onClick={() => onAdd(server.name)} title="Add MCP server" aria-label={`Add ${server.name}`}>
                            <i className="codicon codicon-add" aria-hidden="true" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </SettingsCard>
          </div>
          <footer className="settingsFooter settingsFooter-showcase">
            <button type="button" className="settingsSecondaryButton" onClick={onRefresh}>
              <i className="codicon codicon-refresh" aria-hidden="true" />
              Refresh
            </button>
            <button type="button" className="settingsSecondaryButton" onClick={() => startEdit()}>
              <i className="codicon codicon-add" aria-hidden="true" />
              Add custom
            </button>
            <button type="button" className="settingsPrimaryButton" onClick={onOpenConfig}>
              <i className="codicon codicon-edit" aria-hidden="true" />
              Edit config.yaml
            </button>
          </footer>
        </>
      )}
    </section>
  );
}

function SessionsScreen({
  sessions,
  notice,
  onBack,
  onRefresh,
  onNew,
  onResume,
  onRename,
  onDelete,
}: {
  readonly sessions: SessionListResult | null;
  readonly notice: string | null;
  readonly onBack: () => void;
  readonly onRefresh: () => void;
  readonly onNew: () => void;
  readonly onResume: (id: string) => void;
  readonly onRename: (session: SessionSummary) => void;
  readonly onDelete: (id: string) => void;
}): ReactElement {
  return (
    <section className="settingsView settingsView-showcase">
      <SettingsHeader title="Sessions" subtitle="Shared with ~/.atlas/sessions" onBack={onBack} onOpenConfig={onNew} onRefresh={onRefresh} variant="showcase" />
      {notice ? <div className="settingsNotice" role="status">{notice}</div> : null}
      {!sessions ? (
        <div className="settingsLoading">Reading saved sessions...</div>
      ) : (
        <>
          <div className="settingsGrid settingsGrid-showcase">
            <SettingsCard title="Saved Sessions" badge={`${sessions.sessions.length} saved`} index={1} variant="showcase" wide>
              <div className="managerList">
                {sessions.sessions.length === 0 ? (
                  <div className="managerEmpty">No saved Atlas sessions yet.</div>
                ) : sessions.sessions.map((session) => (
                  <div key={session.id} className="managerRow">
                    <div>
                      <span>{session.title ?? session.id}</span>
                      <small>{session.id} · {formatDate(session.updatedAt)}</small>
                    </div>
                    <div className="managerRowActions">
                      {session.active ? <StatusPill tone="active" label="active" /> : null}
                      <button type="button" onClick={() => onResume(session.id)} title="Resume session" aria-label={`Resume ${session.id}`}>
                        <i className="codicon codicon-debug-start" aria-hidden="true" />
                      </button>
                      <button type="button" onClick={() => onRename(session)} title="Rename session" aria-label={`Rename ${session.id}`}>
                        <i className="codicon codicon-edit" aria-hidden="true" />
                      </button>
                      <button type="button" onClick={() => onDelete(session.id)} title="Delete session" aria-label={`Delete ${session.id}`}>
                        <i className="codicon codicon-trash" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </SettingsCard>
          </div>
          <footer className="settingsFooter settingsFooter-showcase">
            <button type="button" className="settingsSecondaryButton" onClick={onRefresh}>
              <i className="codicon codicon-refresh" aria-hidden="true" />
              Refresh
            </button>
            <button type="button" className="settingsPrimaryButton" onClick={onNew}>
              <i className="codicon codicon-add" aria-hidden="true" />
              New session
            </button>
          </footer>
        </>
      )}
    </section>
  );
}

function TaskScreen({
  status,
  todos,
  notice,
  onBack,
  onRefresh,
}: {
  readonly status: TaskStatusResult | null;
  readonly todos: TodoStatusResult | null;
  readonly notice: string | null;
  readonly onBack: () => void;
  readonly onRefresh: () => void;
}): ReactElement {
  const todoRows = todos?.todos ?? [];

  return (
    <section className="settingsView settingsView-showcase">
      <SettingsHeader title="Status" subtitle="Current Atlas workflow task" onBack={onBack} onOpenConfig={onRefresh} onRefresh={onRefresh} variant="showcase" />
      {notice ? <div className="settingsNotice" role="status">{notice}</div> : null}
      {!status ? (
        <div className="settingsLoading">Reading workflow state...</div>
      ) : (
        <div className="settingsGrid settingsGrid-showcase">
          <SettingsCard title={status.task?.title || 'Workflow Task'} badge={status.task?.phase ?? 'idle'} index={1} variant="showcase" badgeTone={phaseTone(status.task?.phase)}>
            {status.task ? (
              <>
                <SettingsMetric label="Task id" value={status.task.id} wide />
                <SettingsMetric label="Phase" value={status.task.phase} />
                <SettingsMetric label="Updated" value={formatDate(status.task.updatedAt)} />
                <SettingsMetric label="Note" value={status.task.note ?? 'none'} wide />
                <SettingsMetric label="Context doc" value={status.task.contextDocPath ?? 'not written'} wide />
                <SettingsMetric label="Plan doc" value={status.task.planDocPath ?? 'not written'} wide />
              </>
            ) : (
              <div className="managerEmpty">No active Atlas workflow task in this workspace.</div>
            )}
          </SettingsCard>

          <SettingsCard title="Session Todos" badge={`${todoRows.length} item${todoRows.length === 1 ? '' : 's'}`} index={2} variant="showcase">
            <div className="todoList">
              {todoRows.length === 0 ? (
                <div className="managerEmpty">No session todos have been created yet.</div>
              ) : todoRows.map((todo) => (
                <div key={todo.id} className="todoRow">
                  <span className={`todoMarker todoMarker-${todo.status}`} aria-hidden="true" />
                  <div>
                    <span>{todo.content}</span>
                    <small>{todo.id}</small>
                  </div>
                  <StatusPill tone={todoStatusTone(todo.status)} label={todo.status} />
                </div>
              ))}
            </div>
          </SettingsCard>
        </div>
      )}
    </section>
  );
}

function SettingsHeader({
  title,
  subtitle,
  onBack,
  onOpenConfig,
  onRefresh,
  variant = 'standard',
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly onBack: () => void;
  readonly onOpenConfig: () => void;
  readonly onRefresh: () => void;
  readonly variant?: 'standard' | 'showcase';
}): ReactElement {
  const showcase = variant === 'showcase';
  return (
    <div className={`settingsHero ${showcase ? 'settingsHero-showcase' : ''}`}>
      <div>
        {!showcase ? (
          <button type="button" className="settingsBackButton" onClick={onBack} aria-label="Back to chat">
            <i className="codicon codicon-arrow-left" aria-hidden="true" />
          </button>
        ) : null}
        {!showcase ? <p className="settingsEyebrow">ATLAS CORE</p> : null}
        <h1>{title}</h1>
        <span>{subtitle}</span>
      </div>
      <div className="settingsHeroActions">
        {showcase ? (
          <button type="button" className="settingsGhostButton" onClick={onBack} title="Back to chat" aria-label="Back to chat">
            <i className="codicon codicon-arrow-left" aria-hidden="true" />
          </button>
        ) : null}
        <button type="button" className="settingsGhostButton" onClick={onRefresh} title="Refresh settings" aria-label="Refresh settings">
          <i className="codicon codicon-refresh" aria-hidden="true" />
        </button>
        <button type="button" className="settingsGhostButton" onClick={onOpenConfig} title="Open config.yaml" aria-label="Open config.yaml">
          <i className="codicon codicon-file-code" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function SettingsCard({
  icon,
  title,
  badge,
  badgeTone,
  index,
  variant = 'standard',
  wide = false,
  sectionId,
  hidden = false,
  collapsible = false,
  open = true,
  onToggle,
  children,
}: {
  readonly icon?: string;
  readonly title: string;
  readonly badge?: string;
  readonly badgeTone?: 'idle' | 'discover' | 'plan' | 'execute' | 'verify' | 'ship';
  readonly index?: number;
  readonly variant?: 'standard' | 'showcase';
  readonly wide?: boolean;
  readonly sectionId?: string;
  readonly hidden?: boolean;
  readonly collapsible?: boolean;
  readonly open?: boolean;
  readonly onToggle?: () => void;
  readonly children: ReactNode;
}): ReactElement {
  const showcase = variant === 'showcase';
  if (hidden) return <></>;
  return (
    <article
      className={`settingsCard ${showcase ? 'settingsCard-showcase' : ''} ${wide ? 'settingsCard-wide' : ''} ${collapsible ? 'settingsCard-collapsible' : ''} ${open ? 'isOpen' : 'isCollapsed'}`}
      {...(sectionId ? { 'data-settings-section': sectionId } : {})}
    >
      <header className="settingsCardHeader">
        {showcase ? null : <span className="settingsCardIcon"><i className={`codicon codicon-${icon ?? 'settings'}`} aria-hidden="true" /></span>}
        <h2>{showcase && index !== undefined ? <><span>{index}. </span>{title}</> : title}</h2>
        {!showcase && badge ? <span className={`settingsBadge ${badgeTone ? `settingsBadge-${badgeTone}` : ''}`}>{badge}</span> : null}
        {collapsible ? (
          <button type="button" className="settingsCardToggle" onClick={onToggle} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}>
            <i className={`codicon codicon-chevron-${open ? 'up' : 'down'}`} aria-hidden="true" />
          </button>
        ) : null}
      </header>
      {open ? <div className="settingsCardBody">{children}</div> : null}
    </article>
  );
}

function SettingsMetric({ label, value, wide = false }: { readonly label: string; readonly value: string; readonly wide?: boolean }): ReactElement {
  return (
    <div className={`settingsMetric ${wide ? 'isWide' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SettingsStat({ label, value }: { readonly label: string; readonly value: number }): ReactElement {
  return (
    <div className="settingsStat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function StatusPill({ tone, label }: { readonly tone: 'active' | 'ok' | 'muted' | 'warn'; readonly label: string }): ReactElement {
  return <span className={`statusPill statusPill-${tone}`}>{label}</span>;
}

function todoStatusTone(status: TodoStatus): 'active' | 'ok' | 'muted' | 'warn' {
  if (status === 'in_progress') return 'active';
  if (status === 'completed') return 'ok';
  if (status === 'cancelled') return 'warn';
  return 'muted';
}

function phaseTone(phase?: string): 'idle' | 'discover' | 'plan' | 'execute' | 'verify' | 'ship' | undefined {
  switch (phase) {
    case 'idle': return 'idle';
    case 'discover': return 'discover';
    case 'plan': return 'plan';
    case 'execute': return 'execute';
    case 'verify': return 'verify';
    case 'ship': return 'ship';
    default: return undefined;
  }
}

function QuickSelect({
  label,
  value,
  options,
  isOpen,
  onToggle,
  onSelect,
  grouped,
  popularFilter,
  minimal,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly QuickOption[];
  readonly isOpen: boolean;
  readonly onToggle: () => void;
  readonly onSelect: (value: QuickOption) => void;
  readonly grouped?: boolean;
  readonly popularFilter?: (id: string) => boolean;
  readonly minimal?: boolean;
}): ReactElement {
  const [search, setSearch] = useState('');
  const active = options.find((option) => option.value === value || option.label === value);
  const filtered = grouped && search.trim().length > 0
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()) || (o.description ?? '').toLowerCase().includes(search.toLowerCase()))
    : options;

  const groups: readonly { readonly label: string; readonly items: readonly QuickOption[] }[] = grouped
    ? groupModelOptions(filtered, popularFilter)
    : [];

  return (
    <div className={`quickSelect ${isOpen ? 'isOpen' : ''}`}>
      <button
        type="button"
        className={minimal ? 'quickSelectTriggerMinimal' : 'quickSelectTrigger'}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={label}
        onClick={onToggle}
      >
        <span className="quickSelectValue">{active?.label ?? value}</span>
        <i className="codicon codicon-chevron-down quickSelectChevron" aria-hidden="true" />
      </button>
      {isOpen ? (
        <div className="quickSelectMenu" role="listbox" aria-label={label}>
          {grouped ? (
            <>
              <div className="quickSelectSearch">
                <i className="codicon codicon-search" aria-hidden="true" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.currentTarget.value)}
                  placeholder="Search models..."
                  autoFocus
                />
              </div>
              <div className="quickSelectGrouped">
                {groups.map((group) => (
                  <div key={group.label} className="quickSelectGroup">
                    <span className="quickSelectGroupHeader">{group.label}</span>
                    {group.items.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`quickSelectOption ${option.value === value || option.label === value ? 'isSelected' : ''} ${popularFilter?.(option.label) ? 'isPopular' : ''}`}
                        role="option"
                        aria-selected={option.value === value || option.label === value}
                        title={option.description}
                        onClick={() => { onSelect(option); setSearch(''); }}
                      >
                        {popularFilter?.(option.label) ? <span className="popularStar">★ </span> : null}
                        <span>{option.label}</span>
                        {option.description ? <small>{option.description}</small> : null}
                      </button>
                    ))}
                  </div>
                ))}
                {groups.length === 0 && search.trim().length > 0 ? (
                  <div className="quickSelectEmpty">No models matched "{search}".</div>
                ) : null}
              </div>
            </>
          ) : (
            <>
              {options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`quickSelectOption ${option.value === value || option.label === value ? 'isSelected' : ''}`}
                  role="option"
                  aria-selected={option.value === value || option.label === value}
                  title={option.description}
                  onClick={() => onSelect(option)}
                >
                  <span>{option.label}</span>
                  {option.description ? <small>{option.description}</small> : null}
                </button>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SlashAutocomplete({
  commands,
  activeIndex,
  onPick,
}: {
  readonly commands: readonly SlashCommand[];
  readonly activeIndex: number;
  readonly onPick: (command: SlashCommand) => void;
}): ReactElement {
  return (
    <div className="slashAutocomplete" role="listbox" aria-label="Atlas slash commands">
      {commands.map((command, index) => (
        <button
          key={command.name}
          type="button"
          className={`slashRow ${index === activeIndex ? 'isActive' : ''}`}
          role="option"
          aria-selected={index === activeIndex}
          onClick={() => onPick(command)}
        >
          <span>/{command.name}</span>
          <small>{command.summary}</small>
        </button>
      ))}
    </div>
  );
}

function ChatBubble({ message, onOpenFile }: { readonly message: ChatMessage; readonly onOpenFile: (reference: FileReference) => void }): ReactElement {
  const roleLabel = message.role === 'assistant' ? 'Atlas' : message.role === 'user' ? 'You' : message.role;
  const usage = message.usage;
  const contextPct = usage ? Math.min(1, usage.totalTokens / 200000) : 0;

  return (
    <article className={`message message-${message.role} ${message.pending ? 'isPending' : ''}`}>
      <div className="messageHeader">
        <span>{roleLabel}</span>
        {usage ? <span>{usage.totalTokens.toLocaleString()} tokens</span> : null}
      </div>
      {message.thinking ? <p className="thinkingText"><RenderableText text={message.thinking} onOpenFile={onOpenFile} /></p> : null}
      <div className="messageBody">
        <RenderableText text={message.content} fallback={message.pending ? '...' : ''} onOpenFile={onOpenFile} />
      </div>
      {message.tools && message.tools.length > 0 ? (
        <div className="toolList">
          {message.tools.map((tool) => <ToolRow key={tool.id} tool={tool} onOpenFile={onOpenFile} />)}
        </div>
      ) : null}
      {usage ? (
        <footer className="usageFooter">
          <span>↑ {usage.promptTokens.toLocaleString()} ↓ {usage.completionTokens.toLocaleString()}</span>
          <div className="contextBar" title={`${Math.round(contextPct * 100)}% of context window`}>
            <div className={`contextFill ${contextPct > 0.8 ? 'contextDanger' : contextPct > 0.5 ? 'contextWarn' : ''}`} style={{ width: `${Math.round(contextPct * 100)}%` }} />
          </div>
        </footer>
      ) : null}
    </article>
  );
}

function ToolRow({ tool, onOpenFile }: { readonly tool: ChatTool; readonly onOpenFile: (reference: FileReference) => void }): ReactElement {
  const fileReference = fileReferenceFromTool(tool);
  const preview = tool.summary ?? tool.arguments;
  return (
    <details className={`toolRow tool-${tool.state}`}>
      <summary>
        <span>{tool.name}</span>
        <span className="toolSummaryActions">
          {fileReference ? (
            <button
              type="button"
              className="toolOpenButton"
              title={`Open ${fileReference.path}`}
              aria-label={`Open ${fileReference.path}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenFile(fileReference);
              }}
            >
              <i className="codicon codicon-go-to-file" aria-hidden="true" />
            </button>
          ) : null}
          <span>{tool.state}</span>
        </span>
      </summary>
      <div className="toolPreview">
        <RenderableText text={preview} onOpenFile={onOpenFile} />
      </div>
    </details>
  );
}

function RenderableText({
  text,
  fallback = '',
  onOpenFile,
}: {
  readonly text: string;
  readonly fallback?: string;
  readonly onOpenFile: (reference: FileReference) => void;
}): ReactElement {
  const parts = splitFileReferences(text || fallback);
  return (
    <>
      {parts.map((part, index) => typeof part === 'string' ? part : (
        <button
          key={`${part.path}:${part.line ?? 0}:${index}`}
          type="button"
          className="fileRefButton"
          title={`Open ${part.path}${part.line ? `:${part.line}` : ''}`}
          onClick={() => onOpenFile(part)}
        >
          {part.path}{part.line ? `:${part.line}` : ''}
        </button>
      ))}
    </>
  );
}

const stripInteractionBlocks = (s: string): string =>
  s.replace(/<atlas:question>[\s\S]*?<\/atlas:question>/g, '').trim();

const renderVisibleAssistant = (buf: string): string => {
  const stripped = buf.replace(/<atlas:question>[\s\S]*?<\/atlas:question>/g, '');
  const open = stripped.indexOf('<atlas:question>');
  return (open >= 0 ? stripped.slice(0, open) : stripped).trimEnd();
};

function applyStreamEvent(
  requestId: string,
  event: BridgeStreamEvent,
  setMessages: (updater: (messages: readonly ChatMessage[]) => readonly ChatMessage[]) => void,
): void {
  switch (event.type) {
    case 'delta':
      updateAssistant(requestId, setMessages, (message) => {
        const raw = `${message.rawContent ?? message.content}${event.text}`;
        return {
          ...message,
          rawContent: raw,
          content: renderVisibleAssistant(raw),
        };
      });
      return;
    case 'thinking':
      updateAssistant(requestId, setMessages, (message) => ({
        ...message,
        thinking: `${message.thinking ?? ''}${event.text}`,
      }));
      return;
    case 'tool_call':
      updateAssistant(requestId, setMessages, (message) => ({
        ...message,
        tools: [...(message.tools ?? []), {
          id: event.call.id,
          name: event.call.name,
          arguments: event.call.arguments,
          state: 'running',
        }],
      }));
      return;
    case 'tool_result':
      updateAssistant(requestId, setMessages, (message) => ({
        ...message,
        tools: (message.tools ?? []).map((tool) => tool.id === event.call.id
          ? {
              ...tool,
              state: event.outcome.type === 'ok' ? 'ok' : 'error',
              summary: event.outcome.type === 'ok' ? event.outcome.summary : event.outcome.error.message,
            }
          : tool),
      }));
      return;
    case 'turn_end':
      updateAssistant(requestId, setMessages, (message) => {
        const raw = message.rawContent ?? message.content;
        const stripped = stripInteractionBlocks(raw);
        return { ...message, content: stripped, rawContent: stripped, pending: false };
      });
      return;
    case 'approval_request':
    case 'approval_resolved':
    case 'clarify_request':
    case 'clarify_resolved':
    case 'learn_reflecting':
    case 'learn_review':
    case 'learn_nothing':
    case 'learn_error':
    case 'learn_saved':
      return;
    case 'done':
      updateAssistant(requestId, setMessages, (message) => ({ ...message, usage: event.usage, pending: false }));
      return;
    case 'error':
      setMessages((current) => [...current, {
        id: createRequestId(),
        requestId,
        role: 'error',
        content: event.error.message,
      }]);
      return;
  }
}

function updateAssistant(
  requestId: string,
  setMessages: (updater: (messages: readonly ChatMessage[]) => readonly ChatMessage[]) => void,
  update: (message: ChatMessage) => ChatMessage,
): void {
  setMessages((current) => current.map((message) => (
    message.requestId === requestId && message.role === 'assistant' ? update(message) : message
  )));
}

function markAssistantDone(
  requestId: string,
  setMessages: (updater: (messages: readonly ChatMessage[]) => readonly ChatMessage[]) => void,
): void {
  updateAssistant(requestId, setMessages, (message) => ({ ...message, pending: false }));
}

const FILE_REFERENCE_PATTERN = /(^|[\s([{"'`])((?:\.{1,2}\/|\/)?(?:[A-Za-z0-9_@+~.-]+\/)+[A-Za-z0-9_@+~.-]+\.[A-Za-z0-9]+|[A-Za-z0-9_@+~.-]+\.[A-Za-z0-9]+)(?::(\d+))?/g;
const FILE_EXTENSIONS = new Set([
  'c', 'cjs', 'cpp', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'jsx',
  'json', 'lock', 'md', 'mdx', 'mjs', 'py', 'rs', 'sh', 'toml', 'ts', 'tsx',
  'txt', 'yaml', 'yml',
]);

function splitFileReferences(text: string): readonly (string | FileReference)[] {
  if (text.length === 0) return [''];
  const parts: Array<string | FileReference> = [];
  let cursor = 0;
  FILE_REFERENCE_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(FILE_REFERENCE_PATTERN)) {
    const fullMatch = match[0] ?? '';
    const prefix = match[1] ?? '';
    const path = match[2];
    if (!path || !isFileLikePath(path)) continue;

    const start = match.index + prefix.length;
    if (start > cursor) parts.push(text.slice(cursor, start));
    const line = match[3] ? Number.parseInt(match[3], 10) : undefined;
    parts.push({ path, ...(line !== undefined ? { line } : {}) });
    cursor = match.index + fullMatch.length;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : [text];
}

function firstFileReference(text: string): FileReference | null {
  for (const part of splitFileReferences(text)) {
    if (typeof part !== 'string') return part;
  }
  return null;
}

function fileReferenceFromTool(tool: ChatTool): FileReference | null {
  const fromArgs = fileReferenceFromToolArguments(tool.arguments);
  if (fromArgs) return fromArgs;
  return firstFileReference(tool.summary ?? '');
}

function fileReferenceFromToolArguments(rawArguments: string): FileReference | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const pathValue = parsed['path'] ?? parsed['filePath'] ?? parsed['targetPath'];
  if (typeof pathValue !== 'string' || !isFileLikePath(pathValue)) return null;
  const lineValue = parsed['line'] ?? parsed['startLine'];
  const columnValue = parsed['column'] ?? parsed['startColumn'];
  return {
    path: pathValue,
    ...(typeof lineValue === 'number' && Number.isInteger(lineValue) && lineValue > 0 ? { line: lineValue } : {}),
    ...(typeof columnValue === 'number' && Number.isInteger(columnValue) && columnValue > 0 ? { column: columnValue } : {}),
  };
}

function isFileLikePath(path: string): boolean {
  if (/^\d+(?:\.\d+)+$/.test(path)) return false;
  const cleanPath = path.replace(/[),.;\]]+$/, '');
  const lastSegment = cleanPath.split('/').pop() ?? cleanPath;
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0 || dot >= lastSegment.length - 1) return false;
  return FILE_EXTENSIONS.has(lastSegment.slice(dot + 1).toLowerCase());
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isStatusResult(input: unknown): input is AtlasStatus {
  return typeof input === 'object' && input !== null && 'ok' in input && 'cwd' in input && !('configPath' in input);
}

function isSettingsResult(input: unknown): input is SettingsSummaryResult {
  return typeof input === 'object' && input !== null && 'configPath' in input && 'cwd' in input && 'ok' in input;
}

function isModelSummaryResult(input: unknown): input is ModelSummaryResult {
  return isRecord(input) && input['ok'] === true && Array.isArray(input['models']) && typeof input['activeModel'] === 'string';
}

function isAgentSummaryResult(input: unknown): input is AgentSummaryResult {
  return isRecord(input) && input['ok'] === true && Array.isArray(input['agents']) && typeof input['activeAgent'] === 'string';
}

function isMcpStatusResult(input: unknown): input is McpStatusResult {
  return isRecord(input) && input['ok'] === true && Array.isArray(input['servers']) && typeof input['configured'] === 'number';
}

function isSessionListResult(input: unknown): input is SessionListResult {
  return isRecord(input) && input['ok'] === true && Array.isArray(input['sessions']) && 'activeSessionId' in input;
}

function isTaskStatusResult(input: unknown): input is TaskStatusResult {
  return isRecord(input) && input['ok'] === true && 'task' in input && !('sessions' in input);
}

function isTodoStatusResult(input: unknown): input is TodoStatusResult {
  return isRecord(input) && input['ok'] === true && Array.isArray(input['todos']);
}

function isRuntimeActionResult(input: unknown): input is RuntimeActionResult {
  return isRecord(input)
    && typeof input['ok'] === 'boolean'
    && !('cwd' in input)
    && !('models' in input)
    && !('agents' in input)
    && !('servers' in input)
    && !('sessions' in input)
    && !('task' in input)
    && !('todos' in input);
}

function isOpenConfigResult(input: unknown): input is OpenConfigResult {
  if (typeof input !== 'object' || input === null || !('path' in input) || !('ok' in input)) return false;
  const record = input as Record<string, unknown>;
  return !('configPath' in record) && !('absolutePath' in record) && !('base64' in record) && !('content' in record) && !('mediaType' in record);
}

function isOpenFileResult(input: unknown): input is OpenFileResult {
  return typeof input === 'object' && input !== null && 'path' in input && 'absolutePath' in input && 'line' in input && 'ok' in input;
}

type Attachment =
  | { readonly type: 'file'; readonly path: string; readonly name: string; readonly content: string }
  | { readonly type: 'image'; readonly path: string; readonly name: string; readonly base64: string; readonly mediaType: string };

function isAttachFileResult(input: unknown): input is { readonly ok: boolean; readonly path?: string; readonly cancelled?: boolean; readonly base64?: string; readonly mediaType?: string; readonly content?: string } {
  if (typeof input !== 'object' || input === null || !('ok' in input)) return false;
  const record = input as Record<string, unknown>;
  return !('absolutePath' in record) && (typeof record['path'] === 'string' || record['cancelled'] === true);
}

function actionNoticeFromResult(result: RuntimeActionResult): string {
  if (!result.ok) return `${result.error.code}: ${result.error.message}`;
  if (typeof result['model'] === 'string') {
    const modelNotice = `Model set to ${result['model']}`;
    if (result['provider'] === 'local') return `${modelNotice} — Lite mode activated.`;
    return modelNotice;
  }
  if (typeof result['agent'] === 'string') return `Agent set to ${result['agent']}`;
  if (typeof result['deleted'] === 'string') return `Deleted session ${result['deleted']}`;
  if (typeof result['mcp'] === 'string') return `MCP ${result['mcp']} updated.`;
  if (typeof result['secret'] === 'string' && typeof result['label'] === 'string') return `${result['label']} ${result['configured'] ? 'stored' : 'cleared'}.`;
  if (result['codexSignIn'] === true) return 'ChatGPT / Codex sign-in complete.';
  if (result['settingsUpdated'] === true) {
    const update = result['update'];
    if (isRecord(update)) {
      if (update['vscodePowerMode'] === 'lite') return 'Lite mode — minimal tools, fastest responses.';
      if (update['vscodePowerMode'] === 'hybrid') return 'Hybrid mode — balanced tool surface.';
      if (update['vscodePowerMode'] === 'full') return 'Full mode — all tools enabled, maximum context.';
      if (update['atlasMode'] === 'smart') return 'Smart mode — cost-aware, cache-friendly.';
      if (update['atlasMode'] === 'full') return 'Power mode — full Atlas power, all tools enabled.';
      if (update['localToolMode'] === 'lite') return 'Local lite mode — minimal tools for local models.';
      if (update['localToolMode'] === 'hybrid') return 'Local hybrid mode — balanced tools for local models.';
      if (update['localToolMode'] === 'full') return 'Local full mode — all tools for local models.';
    }
    return 'Atlas settings updated.';
  }
  if (result['sessionRenameCancelled'] === true) return 'Session rename cancelled.';
  if (isRecord(result['session']) && typeof result['session']['id'] === 'string') {
    return `Active session ${result['session']['id']}`;
  }
  if (typeof result['cancelled'] === 'boolean') return result['cancelled'] ? 'Cancellation requested.' : 'No turn is running.';
  return 'Atlas state updated.';
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function nextThinking(current: ThinkingLevel, available: readonly ThinkingLevel[]): ThinkingLevel {
  const idx = available.indexOf(current);
  if (idx === -1) return available[0] ?? 'off';
  return available[(idx + 1) % available.length] ?? 'off';
}

const isPopularModelId = (id: string): boolean => {
  const m = id.toLowerCase();
  return (
    /^anthropic\/claude-opus-4[.\-]?7/.test(m) ||
    /^anthropic\/claude-opus-4[.\-]?6/.test(m) ||
    /^anthropic\/claude-sonnet-4[.\-]?6/.test(m) ||
    /^anthropic\/claude-sonnet-4[.\-]?5/.test(m) ||
    /^deepseek\/deepseek-v?4/.test(m) ||
    /^moonshotai\/kimi-?[kq]?2[.\-]?6/.test(m) ||
    /^openai\/gpt-5[.\-]?5/.test(m) ||
    /^openai\/gpt-5$/.test(m) ||
    /^google\/gemini-2\.5-pro/.test(m) ||
    /^google\/gemini-2\.5-flash/.test(m) ||
    /^meta-llama\/llama-4/.test(m) ||
    /^deepseek\/deepseek-r1/.test(m)
  );
};

const MODEL_PROVIDER_ORDER: readonly ModelProviderKind[] = [
  'local', 'anthropic', 'openai-codex', 'opencode-go', 'opencode-zen', 'openrouter',
];

const MODEL_PROVIDER_LABELS: Readonly<Record<ModelProviderKind, string>> = {
  local: '── Local (Ollama / LM Studio) ──',
  anthropic: '── Anthropic ──',
  'openai-codex': '── OpenAI (ChatGPT / Codex) ──',
  'opencode-go': '── OpenCode Go ──',
  'opencode-zen': '── OpenCode Zen ──',
  openrouter: '── OpenRouter ──',
};

function groupModelOptions(
  options: readonly QuickOption[],
  popularFilter?: (id: string) => boolean,
): readonly { readonly label: string; readonly items: readonly QuickOption[] }[] {
  const byProvider = new Map<ModelProviderKind, QuickOption[]>();
  for (const option of options) {
    const provider = option.value.split(':')[0] as ModelProviderKind;
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider)!.push(option);
  }

  const groups: { label: string; items: readonly QuickOption[] }[] = [];
  for (const provider of MODEL_PROVIDER_ORDER) {
    const items = byProvider.get(provider);
    if (!items || items.length === 0) continue;
    const label = MODEL_PROVIDER_LABELS[provider] ?? `── ${provider} ──`;

    if (provider === 'openrouter' && popularFilter) {
      const popular = items.filter((o) => popularFilter(o.label));
      const rest = items.filter((o) => !popularFilter(o.label));
      const subItems: QuickOption[] = [];
      if (popular.length > 0) {
        subItems.push(...popular);
      }
      if (rest.length > 0) {
        subItems.push(...rest);
      }
      groups.push({ label, items: subItems });
    } else {
      groups.push({ label, items });
    }
  }
  return groups;
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function resizeTextarea(target: HTMLTextAreaElement): void {
  target.style.height = '0px';
  target.style.height = `${Math.min(target.scrollHeight, 176)}px`;
}

function getVsCodeApi(): VsCodeApi {
  if (typeof globalThis.acquireVsCodeApi === 'function') return globalThis.acquireVsCodeApi();
  return { postMessage: () => undefined };
}

const app = document.querySelector('#app');
if (!(app instanceof HTMLElement)) {
  throw new Error('Atlas webview root was not found.');
}

createRoot(app).render(<App />);
