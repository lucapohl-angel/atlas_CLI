/**
 * Atlas TUI — Ink-based interactive shell.
 *
 * Layout (top → bottom):
 *   ┌─────────────────────────────────────────────┐
 *   │ Header (agent · model · mode · thinking · usage)
 *   ├─────────────────────────────────────────────┤
 *   │ Transcript (messages, tool calls, thinking)
 *   ├─────────────────────────────────────────────┤
 *   │ Overlay (option picker / model picker / agent picker)
 *   ├─────────────────────────────────────────────┤
 *   │ Input (multiline) — slash autocomplete
 *   ├─────────────────────────────────────────────┤
 *   │ Status bar (keybinding hints, Ctrl-D twice to exit)
 *   └─────────────────────────────────────────────┘
 *
 * Keybindings:
 *   Tab          next agent
 *   Shift-Tab    open agent picker
 *   Ctrl-O       open model picker (also: /models)
 *   Ctrl-T       cycle thinking effort
 *   Ctrl-P       cycle mode: plan → build → autopilot (autopilot prompts for consent once)
 *   Esc          cancel current stream
 *   Ctrl-C       cancel current stream (no-op when idle — leaves Ctrl+C free
 *                for terminal text-copy shortcuts)
 *   Ctrl-D ×2    exit (within 1s)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { runAiAddMcp, type AiAddMcpEvent } from './mcp-ai-add.js';
import { runGithubDeviceFlow } from './github-oauth.js';
import {
  buildReflectionMessages,
  describeLearnReason,
  parseLearnedSkillDraft,
  shouldOfferLearn
} from './learn.js';
import {
  ATLAS_VERSION,
  DEFAULT_BUILTIN_MCP_SERVERS,
  MCP_SUGGESTIONS,
  allowAllPolicy,
  compactIfNeeded,
  createOpenRouterProvider,
  denyAllPolicy,
  loadClaudeCodeCredentials,
  estimateOnboardCost,
  beginCodexLogin,
  fetchOpenRouterModels,
  fetchAnthropicModels,
  fetchCodexModels,
  findSuggestion,
  findOnPath,
  renderHeaders,
  runAgentLoop,
  type HookRegistry,
  type SessionRecord,
  SessionStore,
  saveConfig,
  thinkingLevelsFor,
  tryExtractInteraction,
  type Agent,
  type AgentRegistry,
  type AtlasConfig,
  type InteractionRequest,
  type LoopEvent,
  type Message,
  type ModelInfo,
  type Provider,
  type ReasoningEffort,
  type SkillRegistry,
  type ToolContext,
  type ToolRegistry,
  buildSystemPrompt,
  isFrameworkAgent,
  estimateCost,
  formatCost,
  saveLearnedSkill,
  setSkillDisabled,
  writeRepoMap,
  type OnboardPreflight,
  type CatalogEntry,
  type ResolvedToolStatus,
  resolveCatalogStatus,
  runToolAction,
  classifyIntent,
  clearActiveTask,
  canRewindTo,
  formatPhaseLine,
  readSignals,
  startTask,
  titleFromMessage,
  updateTask,
  PHASES,
  type Phase,
  type TaskState
} from '@atlas/core';

export type ThinkingEffort = 'off' | ReasoningEffort | 'xhigh';

const THINKING_CYCLE: readonly ThinkingEffort[] = ['off', 'low', 'medium', 'high', 'xhigh'];

interface TranscriptItem {
  readonly key: string;
  readonly kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'system' | 'error';
  readonly text: string;
  /** Display name for the speaker (e.g. 'atlas', 'hermes'). */
  readonly author?: string;
}

/** Draft skill produced by the reflection sub-call, awaiting user confirmation. */
interface LearnedSkillDraft {
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly body: string;
}

type OnboardMode = 'full' | 'cost-reduction' | 'map-only';
type OnboardStrategy = 'same-model' | 'cheap-fallback' | 'manual';

interface OnboardDraft {
  readonly preflight: OnboardPreflight;
  readonly mode: OnboardMode;
  readonly strategy: OnboardStrategy;
  readonly sameModel?: string;
  readonly cheapModel?: string;
  readonly fallbackModel?: string;
  readonly stageModels?: {
    readonly map: string;
    readonly architecture: string;
    readonly onboarding: string;
  };
}


export interface TuiAppProps {
  /** When null, the App opens with a setup overlay until the user configures a key. */
  readonly provider: Provider | null;
  /**
   * All providers the user has credentials for. The active provider is
   * picked from this map based on the currently selected model's source.
   * Lets the user keep ChatGPT/Claude Code/OpenRouter all signed in and
   * switch between them just by switching models.
   */
  readonly providers?: Partial<
    Record<'openrouter' | 'anthropic' | 'openai-codex', Provider>
  >;
  readonly agents: AgentRegistry;
  readonly skills: SkillRegistry;
  readonly tools: ToolRegistry;
  readonly toolContext: ToolContext;
  /** Optional guardrail hook registry. When supplied, it is wired into every agent-loop turn. */
  readonly hooks?: HookRegistry;
  readonly defaultModel: string;
  readonly fallbackModels?: readonly string[];
  readonly availableModels?: readonly string[];
  /** Catalog from the active provider, used for thinking-level detection. */
  readonly modelCatalog?: readonly import('@atlas/core').ModelInfo[];
  readonly initialAgentName?: string;
  readonly config?: AtlasConfig;
  /** A non-fatal config error message to surface in the setup overlay. */
  readonly setupError?: string;
  /**
   * Live status of MCP servers spawned at TUI boot. `running` lists
   * the servers we successfully connected to (and how many tools each
   * exposed); `failed` carries spawn/list errors so `/mcps` can show
   * what went wrong. Both default to empty.
   */
  readonly mcpStatus?: {
    readonly running: readonly { name: string; toolCount: number }[];
    readonly failed: readonly { name: string; error: string }[];
  };
  /**
   * Persistent session store. When provided, every completed turn is
   * appended to the session JSON on disk so the user can `/resume` it
   * later (or pass `--resume <id>` on the next CLI launch). Optional
   * so non-interactive callers (tests, one-shot scripts) can skip it.
   */
  readonly sessionStore?: SessionStore;
  /** Initial session — created or loaded by runTui before mounting. */
  readonly initialSession?: SessionRecord;
  /**
   * Workflow phase state for the current cwd, loaded by runTui at
   * boot. When null, the user has no active task and the phase chip
   * shows `idle`. The App advances this state implicitly as the
   * conversation progresses — there are no explicit slash commands
   * for the phase pipeline (`/discuss`, `/plan`, etc.). The user
   * still has a small set of operational overrides: `/status`,
   * `/back <phase>`, `/skip`, `/abort`.
   */
  readonly initialActiveTask?: TaskState | null;
}

type Mode = 'plan' | 'build' | 'autopilot';
const MODE_CYCLE: readonly Mode[] = ['plan', 'build', 'autopilot'];

type Overlay =
  | { readonly kind: 'none' }
  | { readonly kind: 'agent-picker' }
  | { readonly kind: 'model-picker'; readonly purpose?: 'chat' | 'compact' }
  | { readonly kind: 'model-freeform' }
  | { readonly kind: 'option-picker'; readonly request: InteractionRequest }
  | { readonly kind: 'option-freeform'; readonly request: InteractionRequest }
  | { readonly kind: 'autopilot-consent' }
  | { readonly kind: 'mcp-add'; readonly stage: 'pick' }
  | {
      readonly kind: 'mcp-add';
      readonly stage: 'prereq';
      readonly suggestionId: string;
      /** True while we're spawning the auto-installer. */
      readonly installing: boolean;
      /** Last installer status / error to surface. */
      readonly statusLine?: string;
    }
  | {
      readonly kind: 'mcp-add';
      readonly stage: 'auth';
      readonly suggestionId: string;
      /** True while we're shelling out to `gh auth token`. */
      readonly probing: boolean;
      readonly statusLine?: string;
    }
  | {
      readonly kind: 'mcp-add';
      readonly stage: 'env';
      readonly suggestionId: string;
      readonly envIndex: number;
      readonly draft: string;
      readonly collected: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'mcp-add';
      readonly stage: 'confirm';
      readonly suggestionId: string;
      readonly collected: Readonly<Record<string, string>>;
    }
  | {
      /** GitHub OAuth Device Flow in progress. The user_code + URL are
       *  shown, the browser is opened, and we poll until they accept,
       *  deny, the code expires, or they cancel via Esc. */
      readonly kind: 'mcp-add';
      readonly stage: 'oauth-device';
      readonly suggestionId: string;
      readonly userCode?: string;
      readonly verificationUri?: string;
      readonly statusLine?: string;
      readonly statusKind?: 'info' | 'pending' | 'error' | 'ok';
    }
  | {
      readonly kind: 'mcp-restart-prompt';
      readonly serverName: string;
      readonly configPath: string;
    }
  | {
      /** Browse / manage the currently-configured MCP servers. */
      readonly kind: 'mcp-list';
      readonly statusLine?: string;
    }
  | {
      /** Per-server actions menu opened from `mcp-list` (or from picking
       *  an already-configured suggestion in the add picker). */
      readonly kind: 'mcp-manage';
      readonly serverName: string;
      readonly statusLine?: string;
    }
  | {
      /** Custom-add menu — manual instructions vs AI-assisted prompt. */
      readonly kind: 'mcp-custom-menu';
    }
  | {
      /** Free-form text input: the user describes which MCP they want
       *  and the constrained AI harness adds it. */
      readonly kind: 'mcp-custom-prompt';
      readonly draft: string;
    }
  | {
      /** AI harness is running. Streams events into the overlay. Once a
       *  successful add lands, transitions to mcp-restart-prompt. */
      readonly kind: 'mcp-custom-running';
      readonly userPrompt: string;
      readonly events: readonly AiAddMcpEvent[];
      readonly currentText: string;
      readonly finished: boolean;
      readonly error?: string;
    }
  | {
      readonly kind: 'session-picker';
      readonly entries: readonly { id: string; updatedAt: string }[];
    }
  | {
      /** `/tools` browser: every built-in tool with a colored status dot. */
      readonly kind: 'tools-list';
      /** Cached resolved status — recomputed on open & after every action. */
      readonly entries: readonly ResolvedToolStatus[];
      readonly statusLine?: string;
      readonly busy?: boolean;
    }
  | {
      /** Per-tool action menu (enable / disable / install / start / stop / remove). */
      readonly kind: 'tools-manage';
      readonly entries: readonly ResolvedToolStatus[];
      readonly toolName: string;
      readonly statusLine?: string;
      readonly busy?: boolean;
      /** When set, render a confirmation prompt for this destructive/essential action. */
      readonly confirm?: {
        readonly actionId: 'disable' | 'remove';
        readonly warning: string;
      };
    }
  | {
      /** Self-improvement loop: confirm whether to promote a draft into a learned skill. */
      readonly kind: 'learn-confirm';
      readonly stage: 'reflecting' | 'review' | 'saving';
      readonly reason: string;
      readonly draft?: LearnedSkillDraft;
      readonly error?: string;
    }
  | {
      readonly kind: 'setup';
      readonly stage: 'menu' | 'key' | 'info';
      readonly draftKey: string;
      readonly target: 'openrouter' | 'anthropic' | 'claude-code' | 'chatgpt' | 'github' | 'mcp';
      readonly infoText?: string;
    }
  | {
      readonly kind: 'onboard';
      readonly stage: 'loading';
    }
  | {
      readonly kind: 'onboard';
      readonly stage: 'mode';
      readonly draft: OnboardDraft;
    }
  | {
      readonly kind: 'onboard';
      readonly stage: 'strategy';
      readonly draft: OnboardDraft;
    }
  | {
      readonly kind: 'onboard';
      readonly stage: 'pick-model';
      readonly draft: OnboardDraft;
      readonly target: 'same' | 'cheap' | 'fallback' | 'map' | 'architecture' | 'onboarding';
    }
  | {
      readonly kind: 'onboard';
      readonly stage: 'confirm';
      readonly draft: OnboardDraft;
    }
  | {
      readonly kind: 'onboard';
      readonly stage: 'running';
      readonly draft: OnboardDraft;
      readonly status: string;
    };

const SetupMenuItem = ({
  isSelected,
  label
}: {
  isSelected?: boolean;
  label: string;
}): React.JSX.Element => {
  // Labels in the setup menu may carry a trailing status suffix
  // separated by a `\u0001` sentinel (e.g. `... \u0001● connected`).
  // Render the prefix in the row's normal color and the suffix in
  // green so users can scan which providers are wired.
  const sep = label.indexOf('\u0001');
  const head = sep < 0 ? label : label.slice(0, sep);
  const tail = sep < 0 ? '' : label.slice(sep + 1);
  return (
    <Text color={isSelected ? 'cyan' : undefined}>
      {head}
      {tail.length > 0 ? <Text color="green">{tail}</Text> : null}
    </Text>
  );
};

const colorForAgent = (name: string): string => {
  // Stable-ish color per agent — purely cosmetic.
  const palette = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'red', 'cyanBright'];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length] ?? 'white';
};

export const TuiApp = (props: TuiAppProps): React.JSX.Element => {
  const app = useApp();
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;

  const allAgents = useMemo(() => props.agents.list(), [props.agents]);
  // Switchable agents = the orchestrator (`atlas`) + every user-added agent.
  // Specialist framework agents (Athena/Prometheus/Hercules/...) are routed to
  // by the orchestrator; the user shouldn't have to remember which one to pick.
  const switchableAgents = useMemo(
    () => allAgents.filter((a) => !isFrameworkAgent(a) || a.name === 'atlas'),
    [allAgents]
  );
  const initialAgent =
    (props.initialAgentName ? props.agents.get(props.initialAgentName) : undefined) ??
    switchableAgents[0] ??
    allAgents[0];

  if (!initialAgent) {
    return (
      <Box>
        <Text color="red">No agents installed. Run `atlas init` first.</Text>
      </Box>
    );
  }

  const [activeAgent, setActiveAgent] = useState<Agent>(initialAgent);
  const [model, setModel] = useState<string>(props.defaultModel);
  /**
   * Models added via the picker's "+ Add custom model id…" entry. Seeded
   * from `~/.atlas/config.yaml` so user-added ids persist across restarts;
   * additions in-session are appended and saved back on submit.
   */
  const [extraModels, setExtraModels] = useState<readonly string[]>(
    () => props.config?.providers.openrouter.customModels ?? []
  );
  /**
   * Live override for the model catalog. Set by `/restart models` after
   * a force-refresh against every connected provider's /models endpoint
   * — bypasses the 24h on-disk cache and updates the picker without
   * needing a restart.
   */
  const [catalogOverride, setCatalogOverride] = useState<readonly ModelInfo[] | undefined>(
    undefined
  );
  const modelCatalog = catalogOverride ?? props.modelCatalog;
  const availableModelIds = useMemo(() => {
    const ids = new Set<string>();
    ids.add(model);
    for (const m of modelCatalog ?? []) ids.add(m.id);
    for (const id of extraModels) ids.add(id);
    return [...ids].sort((a, b) => a.localeCompare(b));
  }, [model, modelCatalog, extraModels]);
  /**
   * Per-agent model override. When an agent has an entry here, requests
   * routed to that agent use this model instead of the global one. Set
   * via `/agent <name> <model>`. Cleared by re-running with no model arg.
   */
  const [agentModels, setAgentModels] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [thinking, setThinking] = useState<ThinkingEffort>(activeAgent.thinkingEffort);
  const [mode, setMode] = useState<Mode>(activeAgent.mode);
  const [autopilotConsented, setAutopilotConsented] = useState(false);
  const [provider, setProvider] = useState<Provider | null>(props.provider);
  /** Tracks which provider kind is currently driving chat. Drives the
   *  header tag and gets rotated when the user picks a model from a
   *  different provider in the picker. */
  const [activeProviderKind, setActiveProviderKind] = useState<
    'openrouter' | 'anthropic' | 'openai-codex' | 'unknown'
  >(() => providerKindFor(props.defaultModel, modelCatalog));
  const [overlay, setOverlay] = useState<Overlay>(() =>
    props.provider
      ? { kind: 'none' }
      : { kind: 'setup', stage: 'menu', draftKey: '', target: 'openrouter' }
  );
  const [input, setInput] = useState('');
  const [slashIdx, setSlashIdx] = useState(0);
  // Transcript scroll position, measured in rendered lines from the bottom.
  // 0 means "stuck to the latest line"; PgUp/PgDn adjust it.
  const [scrollOffset, setScrollOffset] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [usage, setUsage] = useState<{
    readonly tokens: number;
    readonly rounds: number;
    readonly promptTokens?: number;
    readonly completionTokens?: number;
  } | null>(null);
  const [pendingExit, setPendingExit] = useState(false);

  /**
   * Workflow phase router state. `activeTask` is null when the user
   * has no in-progress task for this cwd; the phase chip in the
   * header shows `idle`. As the user talks, `classifyIntent` advances
   * this state implicitly (see post-submit hook below). Persisted to
   * `<cwd>/.atlas/tasks/<id>/state.json` so it survives restarts.
   */
  const [activeTask, setActiveTask] = useState<TaskState | null>(
    props.initialActiveTask ?? null
  );
  const activeTaskRef = useRef<TaskState | null>(activeTask);
  useEffect(() => {
    activeTaskRef.current = activeTask;
  }, [activeTask]);

  const pickCheapestModel = useCallback((): string => {
    const ranked = availableModelIds.find((id) => /(mini|flash|haiku|kimi|nano|lite)/i.test(id));
    return ranked ?? model;
  }, [availableModelIds, model]);

  const pickStrongFallbackModel = useCallback((): string => {
    const ranked = availableModelIds.find((id) => /(opus|gpt-5\.5|sonnet-4\.6|gemini-2\.5-pro)/i.test(id));
    return ranked ?? model;
  }, [availableModelIds, model]);

  // Mouse capture is intentionally NOT enabled. Capturing mouse events
  // would prevent the user from selecting/copying text with the mouse,
  // and the SGR escape sequences leak into Ink's input parser (Ink
  // pulls bytes via stdin.read() from a 'readable' listener, so they
  // can't be intercepted via a data-event hook). Scroll is keyboard-
  // only: PgUp/PgDn (half page) and Shift+↑/↓ (one line). This also
  // means terminal-native click-and-drag selection just works.

  const messagesRef = useRef<Message[]>([]);
  // Session: id is shown in the header; the record is mutated in place
  // and persisted via SessionStore.write() on every turn_end. When no
  // store is provided (tests, scripts) we still keep an in-memory id so
  // the header has something stable to display.
  const sessionRef = useRef<SessionRecord | null>(props.initialSession ?? null);
  const [sessionId, setSessionId] = useState<string | null>(
    props.initialSession?.id ?? null
  );
  const abortRef = useRef<AbortController | null>(null);
  const transcriptKey = useRef(0);
  const ctrlCTimer = useRef<NodeJS.Timeout | null>(null);

  // Self-improvement loop: per-turn counters used by the heuristic that
  // decides whether to offer to distill a "learned skill" from the turn.
  // Reset at the start of each submitMessage; updated during the loop.
  const turnRoundsRef = useRef(0);
  const turnToolErrorsRef = useRef(0);
  const lastUserMessageRef = useRef('');
  /** Inflight reflection abort controller (Esc cancels it). */
  const reflectAbortRef = useRef<AbortController | null>(null);
  /** Soft toggle: user can disable auto-learn via `/learn off`. Defaults on. */
  const learnEnabledRef = useRef<boolean>(true);

  // Auto-compaction live overrides. Defaults come from `props.config.compaction`
  // (loaded from ~/.atlas/config.yaml). `/compact` slash commands mutate
  // these in place AND persist via saveConfig so the choice sticks.
  const compactEnabledRef = useRef<boolean>(
    props.config?.compaction?.enabled ?? true
  );
  const compactModelRef = useRef<string | null>(
    props.config?.compaction?.model ?? null
  );
  const compactThresholdRef = useRef<number>(
    props.config?.compaction?.threshold ?? 0.8
  );
  const compactContextTokensRef = useRef<number>(
    props.config?.compaction?.contextTokens ?? 200_000
  );

  const pushItem = useCallback(
    (kind: TranscriptItem['kind'], text: string, author?: string): void => {
      transcriptKey.current += 1;
      setTranscript((prev) => [
        ...prev,
        { key: `t${transcriptKey.current}`, kind, text, ...(author ? { author } : {}) }
      ]);
      // New content always re-anchors the view to the bottom so the
      // user sees the latest line; PgUp re-engages scroll mode.
      setScrollOffset(0);
    },
    []
  );

  const launchOnboardWizard = useCallback((): void => {
    setOverlay({ kind: 'onboard', stage: 'loading' });
    void (async (): Promise<void> => {
      const preflight = await estimateOnboardCost({ cwd: process.cwd() });
      if (!preflight.ok) {
        pushItem('error', `onboard preflight failed: ${preflight.error.message}`);
        setOverlay({ kind: 'none' });
        return;
      }
      const draft: OnboardDraft = {
        preflight: preflight.value,
        mode: 'full',
        strategy: 'same-model',
        sameModel: model,
        cheapModel: pickCheapestModel(),
        fallbackModel: pickStrongFallbackModel(),
        stageModels: {
          map: pickCheapestModel(),
          architecture: model,
          onboarding: model
        }
      };
      setOverlay({ kind: 'onboard', stage: 'mode', draft });
    })();
  }, [model, pushItem, pickCheapestModel, pickStrongFallbackModel]);

  const updateLastIfSameKind = useCallback(
    (kind: TranscriptItem['kind'], text: string, author?: string): void => {
      setTranscript((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.kind === kind) {
          return [...prev.slice(0, -1), { ...last, text: last.text + text }];
        }
        transcriptKey.current += 1;
        return [
          ...prev,
          { key: `t${transcriptKey.current}`, kind, text, ...(author ? { author } : {}) }
        ];
      });
      setScrollOffset(0);
    },
    []
  );

  /**
   * Replace the visible transcript with items reconstructed from a
   * persisted Message[]. Used by /resume so the user actually sees
   * their prior conversation, not just an empty screen.
   *
   * Mapping:
   *  - user        → 'user' bubble
   *  - assistant + content   → 'assistant' bubble
   *  - assistant + toolCalls → one 'tool' line per call (name + args summary)
   *  - tool                  → 'tool' line with the result (truncated)
   *  - system                → skipped (system prompt is regenerated each turn)
   */
  const hydrateTranscriptFromMessages = useCallback(
    (msgs: readonly Message[], authorHint?: string): void => {
      const items: TranscriptItem[] = [];
      let k = transcriptKey.current;
      const push = (
        kind: TranscriptItem['kind'],
        text: string,
        author?: string
      ): void => {
        k += 1;
        items.push({ key: `t${k}`, kind, text, ...(author ? { author } : {}) });
      };
      for (const m of msgs) {
        if (m.role === 'system') continue;
        if (m.role === 'user') {
          if (m.content.trim()) push('user', m.content);
          continue;
        }
        if (m.role === 'assistant') {
          if (m.content.trim()) push('assistant', m.content, authorHint);
          for (const tc of m.toolCalls ?? []) {
            const argPreview = tc.arguments.length > 120
              ? `${tc.arguments.slice(0, 117)}…`
              : tc.arguments;
            push('tool', `→ ${tc.name}(${argPreview})`);
          }
          continue;
        }
        if (m.role === 'tool') {
          const preview = m.content.length > 400
            ? `${m.content.slice(0, 397)}…`
            : m.content;
          push('tool', `← ${m.name ?? 'tool'}: ${preview}`);
          continue;
        }
      }
      transcriptKey.current = k;
      setTranscript(items);
      setScrollOffset(0);
    },
    []
  );

  /**
   * Self-improvement loop: kick off a reflection sub-call that asks the
   * model whether the just-finished turn contains a procedurally
   * reusable lesson worth saving as a SKILL.md. The reflection runs
   * against the active provider via a single non-tool stream. When a
   * draft comes back, it surfaces in the `learn-confirm` overlay so
   * the user can Save / Edit / Discard. Esc cancels the in-flight call.
   */
  const launchLearnReflection = useCallback(
    async (reason: string): Promise<void> => {
      if (!provider) {
        pushItem('error', 'cannot reflect: no provider configured');
        return;
      }
      // Cancel any prior reflection still streaming.
      reflectAbortRef.current?.abort();
      const ac = new AbortController();
      reflectAbortRef.current = ac;
      setOverlay({ kind: 'learn-confirm', stage: 'reflecting', reason });
      const effectiveModel = agentModels.get(activeAgent.name) ?? model;
      const reflectionMsgs = buildReflectionMessages(messagesRef.current, reason);
      let buf = '';
      try {
        const stream = provider.stream({
          model: effectiveModel,
          messages: reflectionMsgs,
          tools: [],
          signal: ac.signal
        });
        for await (const ev of stream) {
          if (ev.type === 'delta') buf += ev.text;
          else if (ev.type === 'error') {
            setOverlay({
              kind: 'learn-confirm',
              stage: 'review',
              reason,
              error: ev.error.message
            });
            return;
          }
          // 'thinking' / 'tool_call*' / 'done' are not interesting here.
        }
      } catch (e) {
        if (ac.signal.aborted) {
          setOverlay({ kind: 'none' });
          return;
        }
        setOverlay({
          kind: 'learn-confirm',
          stage: 'review',
          reason,
          error: (e as Error).message
        });
        return;
      }
      const parsed = parseLearnedSkillDraft(buf);
      if (!parsed.ok) {
        setOverlay({
          kind: 'learn-confirm',
          stage: 'review',
          reason,
          error: parsed.error
        });
        return;
      }
      if (parsed.draft === null) {
        // The model decided there was nothing reusable. Just close
        // silently — no need to bother the user.
        setOverlay({ kind: 'none' });
        return;
      }
      setOverlay({
        kind: 'learn-confirm',
        stage: 'review',
        reason,
        draft: parsed.draft
      });
    },
    [provider, model, agentModels, activeAgent, pushItem]
  );

  /**
   * Persist the confirmed draft as a learned skill: writes
   * `~/.atlas/skills/<slug>/SKILL.md` with `kind: learned` and adds
   * the skill to the live registry so framework agents see it on
   * their next turn (without restarting the CLI).
   */
  const saveLearnedSkillDraft = useCallback(
    async (draft: LearnedSkillDraft): Promise<void> => {
      setOverlay((o) =>
        o.kind === 'learn-confirm' ? { ...o, stage: 'saving' } : o
      );
      const r = await saveLearnedSkill({
        name: draft.name,
        description: draft.description,
        triggers: draft.triggers,
        body: draft.body,
        createdBy: activeAgent.name,
        createdFromSession: sessionRef.current?.id ?? undefined,
        createdReason:
          overlay.kind === 'learn-confirm' ? overlay.reason : undefined
      });
      if (!r.ok) {
        setOverlay((o) =>
          o.kind === 'learn-confirm' ? { ...o, stage: 'review', error: r.error.message } : o
        );
        return;
      }
      props.skills.add(r.value);
      setOverlay({ kind: 'none' });
      pushItem('system', `Saved learned skill: ${r.value.name} — ${r.value.description}`);
    },
    [activeAgent, props.skills, pushItem, overlay]
  );

  // Switch agent — reset per-agent defaults but keep transcript + history.
  const switchAgent = useCallback(
    (next: Agent): void => {
      setActiveAgent(next);
      setMode(next.mode);
      setThinking(next.thinkingEffort);
      pushItem('system', `Switched to ${next.role}${next.personaAlias ? ` (${next.personaAlias})` : ''}.`);
    },
    [pushItem]
  );

  const cycleAgent = useCallback((): void => {
    if (switchableAgents.length <= 1) return;
    const idx = switchableAgents.findIndex((a) => a.name === activeAgent.name);
    const next = switchableAgents[(idx + 1) % switchableAgents.length];
    if (next) switchAgent(next);
  }, [switchableAgents, activeAgent.name, switchAgent]);

  const allowedThinking = useMemo(
    () => thinkingLevelsFor(model, modelCatalog ?? []) as readonly ThinkingEffort[],
    [model, modelCatalog]
  );

  const cycleThinking = useCallback((): void => {
    setThinking((prev) => {
      const idx = allowedThinking.indexOf(prev);
      const next = allowedThinking[(idx + 1) % allowedThinking.length] ?? 'off';
      return next;
    });
  }, [allowedThinking]);

  // When the model changes, downgrade `thinking` if the new model doesn't
  // support the current level (e.g. switching from opus-4.7 xhigh → haiku).
  useEffect(() => {
    setThinking((prev) =>
      allowedThinking.includes(prev) ? prev : (allowedThinking[allowedThinking.length - 1] ?? 'off')
    );
  }, [allowedThinking]);

  // Request autopilot. If the user has already consented this session, just
  // flip the mode; otherwise show the consent overlay first.
  const requestAutopilot = useCallback((): void => {
    if (autopilotConsented) {
      setMode('autopilot');
      return;
    }
    setOverlay({ kind: 'autopilot-consent' });
  }, [autopilotConsented]);

  const cycleMode = useCallback((): void => {
    setMode((m) => {
      const idx = MODE_CYCLE.indexOf(m);
      const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length] ?? 'build';
      if (next === 'autopilot' && !autopilotConsented) {
        // defer the actual mode flip until the user accepts the popup
        setOverlay({ kind: 'autopilot-consent' });
        return m;
      }
      return next;
    });
  }, [autopilotConsented]);

  const togglePlanBuild = cycleMode;

  const cancelStream = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  // Ctrl-C: cancel current stream when one is running. Otherwise it's
  // a no-op so the terminal emulator can use Ctrl+C for copy when text
  // is selected. (Use Ctrl-D twice to actually exit atlas.)
  const handleCtrlC = useCallback((): void => {
    if (streaming) {
      cancelStream();
    }
  }, [streaming, cancelStream]);

  // Ctrl-D twice in 1s exits. Standard shell-style EOF; doesn't clash
  // with the terminal's copy/paste keybindings.
  const handleCtrlD = useCallback((): void => {
    if (pendingExit) {
      app.exit();
      return;
    }
    setPendingExit(true);
    if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
    ctrlCTimer.current = setTimeout(() => setPendingExit(false), 1000);
  }, [pendingExit, app]);

  // Submit a user message — kicks off the agent loop.
  const submit = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      if (streaming) return;

      // Slash commands handled inline — no model round-trip.
      if (trimmed.startsWith('/')) {
        const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
        switch (cmd) {
          case 'help':
            pushItem('system', SLASH_HELP);
            return;
          case 'clear':
            messagesRef.current = [];
            setTranscript([]);
            setUsage(null);
            return;
          case 'learn': {
            const sub = (rest[0] ?? '').toLowerCase();
            if (sub === 'on') {
              learnEnabledRef.current = true;
              pushItem('system', 'auto-learn is ON — Atlas will offer to distill skills after hard turns.');
              return;
            }
            if (sub === 'off') {
              learnEnabledRef.current = false;
              pushItem('system', 'auto-learn is OFF.');
              return;
            }
            if (sub === 'status') {
              pushItem('system', `auto-learn: ${learnEnabledRef.current ? 'on' : 'off'}`);
              return;
            }
            // No subcommand → manually trigger a reflection on the current
            // transcript (useful when the heuristic didn't fire but the
            // user knows something reusable just happened).
            if (messagesRef.current.length === 0) {
              pushItem('error', 'nothing to learn from yet.');
              return;
            }
            void launchLearnReflection('manual /learn');
            return;
          }
          case 'skills': {
            const sub = (rest[0] ?? 'list').toLowerCase();
            const target = rest.slice(1).join(' ').trim();
            const all = props.skills.list();
            if (sub === 'list' || sub === '') {
              if (all.length === 0) {
                pushItem('system', 'no skills installed.');
                return;
              }
              const lines = all.map((s) => {
                const tag = s.kind === 'learned' ? 'learned' : s.kind === 'builtin' ? 'builtin' : 'user';
                const ver = s.version ?? '0.1.0';
                return `${s.name.padEnd(36)} ${tag.padEnd(8)} v${ver}  — ${s.description}`;
              });
              pushItem('system', lines.join('\n'));
              return;
            }
            if (sub === 'disable' || sub === 'enable') {
              if (target.length === 0) {
                pushItem('error', `usage: /skills ${sub} <name>`);
                return;
              }
              // Match by exact name first, then by case-insensitive prefix.
              const exact = all.find((s) => s.name === target);
              const fuzzy = exact ?? all.find((s) => s.name.toLowerCase().startsWith(target.toLowerCase()));
              if (!fuzzy) {
                pushItem('error', `no such skill: ${target}`);
                return;
              }
              void (async (): Promise<void> => {
                const r = await setSkillDisabled(fuzzy.path, sub === 'disable');
                if (!r.ok) {
                  pushItem('error', `failed to ${sub} ${fuzzy.name}: ${r.error.message}`);
                  return;
                }
                if (sub === 'disable') {
                  // Remove from in-memory registry so the next turn's
                  // system prompt sees the change without a restart.
                  // SkillRegistry has no `remove`; rebuild via re-add of
                  // a "tombstoned" entry would be ugly. Simplest: leave
                  // the user to restart, but reflect the state in the
                  // confirmation message.
                  pushItem(
                    'system',
                    `disabled ${fuzzy.name} (${r.value}). Restart Atlas to drop it from the active session.`
                  );
                } else {
                  pushItem(
                    'system',
                    `enabled ${fuzzy.name} (${r.value}). Restart Atlas to load it into the active session.`
                  );
                }
              })();
              return;
            }
            pushItem('error', `usage: /skills [list|disable <name>|enable <name>]`);
            return;
          }
          case 'next': {
            // Ask the orchestrator/persona to narrate the next handoff.
            // The convention is the `*next` agent command — we inject it
            // verbatim so the model picks it up via the persona prompt.
            void submit('*next');
            return;
          }
          case 'onboard': {
            launchOnboardWizard();
            return;
          }
          case 'tools': {
            void (async () => {
              const registered = new Set(props.tools.list().map((t) => t.name));
              const entries = await resolveCatalogStatus(registered);
              setOverlay({ kind: 'tools-list', entries });
            })();
            return;
          }
          case 'history':
            pushItem(
              'system',
              messagesRef.current
                .map((m) => `[${m.role}] ${m.content.slice(0, 200)}`)
                .join('\n') || '(empty)'
            );
            return;
          case 'model': {
            const id = rest.join(' ').trim();
            if (id.length === 0) {
              setOverlay({ kind: 'model-picker' });
            } else {
              setModel(id);
              pushItem('system', `model → ${id}`);
            }
            return;
          }
          case 'models': {
            setOverlay({ kind: 'model-picker' });
            return;
          }
          case 'restart': {
            const sub = (rest[0] ?? '').toLowerCase();
            if (sub !== 'models') {
              pushItem('error', 'usage: /restart models');
              return;
            }
            pushItem('system', 'refreshing model catalogs (forcing live fetch)…');
            const cfg = props.config;
            void (async (): Promise<void> => {
              const tasks: Promise<readonly ModelInfo[]>[] = [];
              if (cfg?.providers.openrouter.apiKey || props.providers?.openrouter) {
                tasks.push(
                  fetchOpenRouterModels({ forceRefresh: true }).then((r) =>
                    r.ok ? r.value : []
                  )
                );
              }
              const anKey = cfg?.providers.anthropic.apiKey;
              if (anKey) {
                tasks.push(
                  fetchAnthropicModels(
                    { kind: 'apiKey', token: anKey },
                    { forceRefresh: true }
                  ).then((r) => (r.ok ? r.value : []))
                );
              } else if (props.providers?.anthropic) {
                tasks.push(
                  (async (): Promise<readonly ModelInfo[]> => {
                    const creds = await loadClaudeCodeCredentials({});
                    if (!creds.ok) return [];
                    const r = await fetchAnthropicModels(
                      { kind: 'oauth', token: creds.value.accessToken },
                      { forceRefresh: true }
                    );
                    return r.ok ? r.value : [];
                  })()
                );
              }
              const codexAuth = cfg?.providers.openai?.codex;
              if (codexAuth?.accessToken) {
                const opts: { accountId?: string; expiresAt?: number; forceRefresh?: boolean } = {
                  forceRefresh: true
                };
                if (codexAuth.accountId) opts.accountId = codexAuth.accountId;
                if (typeof codexAuth.expiresAt === 'number') opts.expiresAt = codexAuth.expiresAt;
                tasks.push(
                  fetchCodexModels(codexAuth.accessToken, opts).then((r) =>
                    r.ok ? r.value : []
                  )
                );
              }
              try {
                const results = await Promise.all(tasks);
                const merged: ModelInfo[] = [];
                const seen = new Set<string>();
                for (const list of results) {
                  for (const m of list) {
                    const key = `${m.provider}:${m.id}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    merged.push(m);
                  }
                }
                setCatalogOverride(merged);
                pushItem(
                  'system',
                  `model catalog refreshed (${merged.length} model${merged.length === 1 ? '' : 's'} across ${results.length} provider${results.length === 1 ? '' : 's'}).`
                );
              } catch (e) {
                pushItem('error', `refresh failed: ${(e as Error).message}`);
              }
            })();
            return;
          }
          case 'agent': {
            const agentId = (rest[0] ?? '').trim();
            const modelArg = rest.slice(1).join(' ').trim();
            if (agentId.length === 0) {
              pushItem('error', 'usage: /agent <name> [model]');
              return;
            }
            const next = props.agents.get(agentId);
            if (!next) {
              pushItem('error', `unknown agent: ${agentId}`);
              return;
            }
            if (modelArg.length === 0) {
              switchAgent(next);
              return;
            }
            // Bind a model to this agent. Resolve fuzzy ids ("depsek4" →
            // "deepseek/deepseek-chat-v4") against the catalog + custom
            // ids the user has added this session.
            const candidates = [
              ...extraModels,
              ...(modelCatalog ?? []).map((m) => m.id)
            ];
            const resolved = resolveFuzzyModel(modelArg, candidates) ?? modelArg;
            setAgentModels((prev) => {
              const m = new Map(prev);
              m.set(next.name, resolved);
              return m;
            });
            pushItem(
              'system',
              resolved === modelArg
                ? `${next.name} → ${resolved}`
                : `${next.name} → ${resolved} (resolved from "${modelArg}")`
            );
            return;
          }
          case 'agents': {
            const lines = allAgents.map((a) => {
              const bound = agentModels.get(a.name);
              const label = bound
                ? `${bound}`
                : `${a.name === activeAgent.name ? model : model} (default)`;
              const star = a.name === activeAgent.name ? '*' : ' ';
              return `${star} ${a.name.padEnd(14)} ${a.role.padEnd(20)} → ${label}`;
            });
            pushItem(
              'system',
              ['agents (* = active, → bound model):', ...lines].join('\n')
            );
            return;
          }
          case 'mode': {
            const id = (rest[0] ?? '').toLowerCase();
            if (id === 'plan' || id === 'build') {
              setMode(id);
              pushItem('system', `mode → ${id}`);
            } else if (id === 'autopilot') {
              requestAutopilot();
            } else {
              pushItem('error', 'usage: /mode plan|build|autopilot');
            }
            return;
          }
          case 'thinking': {
            const id = (rest[0] ?? '').toLowerCase() as ThinkingEffort;
            if (THINKING_CYCLE.includes(id) && allowedThinking.includes(id)) {
              setThinking(id);
              pushItem('system', `thinking → ${id}`);
            } else if (THINKING_CYCLE.includes(id)) {
              pushItem('error', `model ${model} only supports: ${allowedThinking.join('|')}`);
            } else {
              pushItem('error', `usage: /thinking ${allowedThinking.join('|')}`);
            }
            return;
          }
          case 'config':
          case 'setup':
            setOverlay({ kind: 'setup', stage: 'menu', draftKey: '', target: 'openrouter' });
            return;
          case 'mcps':
          case 'mcp': {
            const sub = (rest[0] ?? '').toLowerCase();
            if (sub === 'add') {
              setOverlay({ kind: 'mcp-add', stage: 'pick' });
              return;
            }
            if (sub === 'remove' || sub === 'rm') {
              const target = rest[1];
              if (!target) {
                pushItem('error', 'usage: /mcps remove <name>');
                return;
              }
              void (async (): Promise<void> => {
                const status = await removeMcp(target);
                if (status.startsWith('error:')) pushItem('error', status.slice(7));
              })();
              return;
            }
            if (sub === 'enable' || sub === 'disable') {
              const target = rest[1];
              if (!target) {
                pushItem('error', `usage: /mcps ${sub} <name>`);
                return;
              }
              const enable = sub === 'enable';
              void (async (): Promise<void> => {
                const status = await setMcpEnabled(target, enable);
                if (status.startsWith('error:')) pushItem('error', status.slice(7));
                else if (status.startsWith('already ')) pushItem('system', `'${target}' is ${status}.`);
              })();
              return;
            }
            // Default `/mcps` (no sub-command) opens an interactive
            // overlay listing the configured servers — the old
            // chat-printout was easy to scroll past and didn't
            // expose the per-server actions.
            setOverlay({ kind: 'mcp-list' });
            return;
          }
          case 'exit':
            app.exit();
            return;
          case 'compact': {
            const sub = rest[0];
            // /compact            → run now (force)
            // /compact status     → show current settings
            // /compact on|off     → toggle
            // /compact model <id> → override summarizer model (and persist)
            // /compact model default → clear override (use active model)
            // /compact threshold <0..1>
            if (!sub || sub === 'now') {
              if (!provider) {
                pushItem('error', 'no provider configured');
                return;
              }
              if (messagesRef.current.length < 2) {
                pushItem('system', 'nothing to compact yet.');
                return;
              }
              const summarizerModel = compactModelRef.current ?? model;
              pushItem('system', `compacting with ${summarizerModel}…`);
              void (async (): Promise<void> => {
                const r = await compactIfNeeded(messagesRef.current, {
                  provider: provider!,
                  summarizerModel,
                  limits: {
                    // Force: drop threshold to 0 so planCompaction always picks.
                    contextTokens: compactContextTokensRef.current,
                    compactThreshold: 0
                  }
                });
                if (!r.ok) {
                  pushItem('error', `compaction failed: ${r.error.message}`);
                  return;
                }
                if (r.value.compacted) {
                  messagesRef.current = [...r.value.messages];
                  pushItem(
                    'system',
                    `compacted ${r.value.summarized} turn${r.value.summarized === 1 ? '' : 's'}.`
                  );
                } else {
                  pushItem('system', 'nothing eligible to compact.');
                }
              })();
              return;
            }
            if (sub === 'status') {
              const m = compactModelRef.current ?? `(active model: ${model})`;
              pushItem(
                'system',
                `compaction: ${compactEnabledRef.current ? 'on' : 'off'}\n` +
                  `  model:     ${m}\n` +
                  `  threshold: ${compactThresholdRef.current} of ${compactContextTokensRef.current} tokens`
              );
              return;
            }
            if (sub === 'on' || sub === 'off') {
              const enabled = sub === 'on';
              compactEnabledRef.current = enabled;
              const baseCfg = props.config;
              if (baseCfg) {
                const next: AtlasConfig = {
                  ...baseCfg,
                  compaction: { ...baseCfg.compaction, enabled }
                };
                void saveConfig(next).then((r) => {
                  if (!r.ok) pushItem('error', `save failed: ${r.error.message}`);
                });
              }
              pushItem('system', `auto-compaction ${enabled ? 'enabled' : 'disabled'}.`);
              return;
            }
            if (sub === 'model') {
              const arg = rest[1];
              if (!arg) {
                // No id given → open the model picker scoped to compaction.
                setOverlay({ kind: 'model-picker', purpose: 'compact' });
                return;
              }
              const newModel = arg === 'default' ? null : arg;
              compactModelRef.current = newModel;
              const baseCfg = props.config;
              if (baseCfg) {
                const nextCompaction = { ...baseCfg.compaction };
                if (newModel) nextCompaction.model = newModel;
                else delete (nextCompaction as { model?: string }).model;
                const next: AtlasConfig = { ...baseCfg, compaction: nextCompaction };
                void saveConfig(next).then((r) => {
                  if (!r.ok) pushItem('error', `save failed: ${r.error.message}`);
                });
              }
              pushItem(
                'system',
                newModel
                  ? `compaction model set to ${newModel}.`
                  : 'compaction model cleared (will use active model).'
              );
              return;
            }
            if (sub === 'threshold') {
              const arg = rest[1];
              const v = arg ? Number(arg) : NaN;
              if (!Number.isFinite(v) || v <= 0 || v > 1) {
                pushItem('error', 'usage: /compact threshold <fraction 0<v≤1>');
                return;
              }
              compactThresholdRef.current = v;
              const baseCfg = props.config;
              if (baseCfg) {
                const next: AtlasConfig = {
                  ...baseCfg,
                  compaction: { ...baseCfg.compaction, threshold: v }
                };
                void saveConfig(next).then((r) => {
                  if (!r.ok) pushItem('error', `save failed: ${r.error.message}`);
                });
              }
              pushItem('system', `compaction threshold set to ${v}.`);
              return;
            }
            pushItem(
              'error',
              'usage: /compact [now|status|on|off|model <id|default>|threshold <0..1>]'
            );
            return;
          }
          case 'sessions':
          case 'resume': {
            if (!props.sessionStore) {
              pushItem('error', 'sessions disabled (no store wired)');
              return;
            }
            const target = rest[0];
            if (target) {
              void (async () => {
                const r = await props.sessionStore!.load(target);
                if (!r.ok) {
                  pushItem('error', `failed to load session ${target}: ${r.error.message}`);
                  return;
                }
                sessionRef.current = r.value;
                messagesRef.current = [...r.value.messages];
                setSessionId(r.value.id);
                hydrateTranscriptFromMessages(
                  r.value.messages,
                  r.value.agent ?? activeAgent.name
                );
                pushItem(
                  'system',
                  `Resumed session ${r.value.id} (${r.value.messages.length} messages).`
                );
              })();
              return;
            }
            void (async () => {
              const list = await props.sessionStore!.list();
              if (!list.ok) {
                pushItem('error', `failed to list sessions: ${list.error.message}`);
                return;
              }
              if (list.value.length === 0) {
                pushItem('system', 'No saved sessions yet.');
                return;
              }
              setOverlay({ kind: 'session-picker', entries: list.value.slice(0, 20) });
            })();
            return;
          }
          default:
            // Workflow phase commands. Kept as a small operational
            // surface (status / back / skip / abort) — the actual
            // pipeline progression is implicit, not command-driven.
            if (cmd === 'status') {
              const current = activeTaskRef.current;
              if (!current) {
                pushItem('system', formatPhaseLine(null));
                return;
              }
              void (async () => {
                const signals = await readSignals(current);
                const head = formatPhaseLine(current, signals);
                const meta = `task: ${current.id} — ${current.title}`;
                pushItem('system', `${head}\n${meta}`);
              })();
              return;
            }
            if (cmd === 'back') {
              const current = activeTaskRef.current;
              if (!current) {
                pushItem('error', 'no active task to rewind');
                return;
              }
              const target = (rest[0] ?? '').toLowerCase() as Phase;
              if (!PHASES.includes(target)) {
                pushItem(
                  'error',
                  `usage: /back <${PHASES.filter((p) => p !== 'idle').join('|')}>`
                );
                return;
              }
              const check = canRewindTo(current, target);
              if (!check.ok) {
                pushItem('error', `cannot rewind: ${check.reason}`);
                return;
              }
              void (async () => {
                const u = await updateTask(current, { phase: target });
                if (u.ok) {
                  setActiveTask(u.value);
                  pushItem('system', `phase rewound: ${current.phase} → ${target}`);
                } else {
                  pushItem('error', `failed to update task: ${u.error.message}`);
                }
              })();
              return;
            }
            if (cmd === 'skip') {
              const current = activeTaskRef.current;
              if (!current) {
                pushItem('error', 'no active task');
                return;
              }
              const idx = PHASES.indexOf(current.phase);
              const next = PHASES[idx + 1];
              if (!next) {
                pushItem('error', `already at terminal phase: ${current.phase}`);
                return;
              }
              void (async () => {
                const u = await updateTask(current, { phase: next });
                if (u.ok) {
                  setActiveTask(u.value);
                  pushItem('system', `phase skipped: ${current.phase} → ${next}`);
                } else {
                  pushItem('error', `failed to update task: ${u.error.message}`);
                }
              })();
              return;
            }
            if (cmd === 'abort') {
              const current = activeTaskRef.current;
              if (!current) {
                pushItem('error', 'no active task to abort');
                return;
              }
              void (async () => {
                const r = await clearActiveTask(props.toolContext.cwd);
                if (r.ok) {
                  setActiveTask(null);
                  pushItem(
                    'system',
                    `task aborted (state preserved at .atlas/tasks/${current.id}/)`
                  );
                } else {
                  pushItem('error', `failed to abort: ${r.error.message}`);
                }
              })();
              return;
            }
            pushItem('error', `unknown command: /${cmd ?? ''}`);
            return;
        }
      }

      // Inline `*command` syntax → expand to a normal user message but tag it.
      if (!provider) {
        pushItem(
          'error',
          'No provider configured. Run /config to configure, or press Esc to open the setup menu.'
        );
        setOverlay({ kind: 'setup', stage: 'menu', draftKey: '', target: 'openrouter' });
        return;
      }
      const userMessage: Message = { role: 'user', content: trimmed };
      messagesRef.current = [...messagesRef.current, userMessage];
      pushItem('user', trimmed, 'user');

      // Reset per-turn counters for the self-improvement heuristic.
      turnRoundsRef.current = 0;
      turnToolErrorsRef.current = 0;
      lastUserMessageRef.current = trimmed;

      // Workflow phase router — observe & advance the implicit pipeline.
      // Runs in the background so a slow disk write never blocks the
      // model turn. Failures are swallowed: a broken workflow store
      // must never break chat. The router only advances *forward*; the
      // user gets explicit `/back` / `/skip` / `/abort` for overrides.
      void (async () => {
        try {
          const cwd = props.toolContext.cwd;
          const current = activeTaskRef.current;
          const signals = current
            ? await readSignals(current)
            : {
                hasContextDoc: false,
                hasPlanDoc: false,
                allTasksCommitted: false,
                allVerifyPassed: false
              };
          const decision = classifyIntent({
            state: current,
            userMessage: trimmed,
            signals
          });
          if (decision.startsNewTask) {
            const created = await startTask({
              cwd,
              title: titleFromMessage(trimmed)
            });
            if (created.ok) setActiveTask(created.value);
          } else if (current && decision.nextPhase !== current.phase) {
            const updated = await updateTask(current, {
              phase: decision.nextPhase
            });
            if (updated.ok) setActiveTask(updated.value);
          }
        } catch {
          // intentionally swallowed — workflow tracking is observational
        }
      })();

      // Compose system message from the active agent on each turn (cheap).
      const skills = props.skills.list();
      // Per-agent override takes precedence over the global model.
      const effectiveModel = agentModels.get(activeAgent.name) ?? model;
      const systemContent = buildSystemPrompt(activeAgent, skills, {
        model: effectiveModel,
        providerLabel: providerLongLabel(activeProviderKind),
        atlasVersion: ATLAS_VERSION
      });
      const seeded: Message[] = [
        { role: 'system', content: systemContent },
        ...messagesRef.current
      ];

      const ac = new AbortController();
      abortRef.current = ac;
      setStreaming(true);

      // Auto-compaction: if enabled and the running token count is above
      // the configured threshold, ask a model (the active one by default,
      // or `compaction.model` if overridden) to roll older turns into a
      // single summary system message. Falls through silently on error.
      if (compactEnabledRef.current && messagesRef.current.length >= 6) {
        const summarizerModel = compactModelRef.current ?? effectiveModel;
        const compRes = await compactIfNeeded(messagesRef.current, {
          provider: provider!,
          summarizerModel,
          limits: {
            contextTokens: compactContextTokensRef.current,
            compactThreshold: compactThresholdRef.current
          },
          signal: ac.signal
        });
        if (compRes.ok && compRes.value.compacted) {
          messagesRef.current = [...compRes.value.messages];
          // Rebuild `seeded` so the freshly compacted history is what
          // we send to the provider, not the pre-compaction snapshot.
          seeded.length = 0;
          seeded.push(
            { role: 'system', content: systemContent },
            ...messagesRef.current
          );
          pushItem(
            'system',
            `(auto-compacted ${compRes.value.summarized} older turn${
              compRes.value.summarized === 1 ? '' : 's'
            } using ${summarizerModel})`
          );
        } else if (!compRes.ok) {
          pushItem('error', `compaction skipped: ${compRes.error.message}`);
        }
      }

      const reasoningOpt =
        thinking === 'off'
          ? undefined
          : thinking === 'xhigh'
            ? { effort: 'high' as ReasoningEffort, maxTokens: 32_000 }
            : { effort: thinking };

      let assistantBuffer = '';
      let totalTokens = 0;
      let promptTokens: number | undefined;
      let completionTokens: number | undefined;
      let rounds = 0;
      // Per-tool-call start timestamps so we can show elapsed time on completion.
      const toolStartedAt = new Map<string, number>();
      // Stable author label for this turn — used for the "agentName:" prefix
      // in the transcript. Captured once so mid-turn agent switches don't
      // mislabel earlier deltas.
      const assistantAuthor = activeAgent.name;
      try {
        for await (const ev of runAgentLoop({
          provider: provider!,
          model: effectiveModel,
          ...(props.fallbackModels ? { fallbackModels: props.fallbackModels } : {}),
          tools: props.tools,
          ...(props.hooks ? { hooks: props.hooks } : {}),
          toolContext: {
            ...props.toolContext,
            approve: mode === 'plan' ? denyAllPolicy : allowAllPolicy,
            callingAgent: {
              name: activeAgent.name,
              ...(activeAgent.authorizedSections
                ? { authorizedSections: activeAgent.authorizedSections }
                : {}),
              ...(activeAgent.forbiddenSections
                ? { forbiddenSections: activeAgent.forbiddenSections }
                : {})
            },
            signal: ac.signal
          },
          initialMessages: seeded,
          ...(reasoningOpt ? { reasoning: reasoningOpt } : {}),
          signal: ac.signal
        })) {
          handleLoopEvent(ev);
        }
      } catch (e) {
        pushItem('error', `loop crashed: ${(e as Error).message}`);
      } finally {
        abortRef.current = null;
        setStreaming(false);
      }

      function handleLoopEvent(ev: LoopEvent): void {
        switch (ev.type) {
          case 'delta':
            assistantBuffer += ev.text;
            // Render the running assistant text *with the question block
            // hidden* — once `<atlas:question>` opens, suppress everything
            // until the matching close tag arrives. Avoids the raw protocol
            // briefly leaking into the chat.
            setTranscript((prev) => {
              const visible = renderVisibleAssistant(assistantBuffer);
              const last = prev[prev.length - 1];
              if (last && last.kind === 'assistant') {
                if (last.text === visible) return prev;
                return [...prev.slice(0, -1), { ...last, text: visible }];
              }
              if (visible.length === 0) return prev;
              transcriptKey.current += 1;
              return [
                ...prev,
                {
                  key: `t${transcriptKey.current}`,
                  kind: 'assistant',
                  text: visible,
                  author: assistantAuthor
                }
              ];
            });
            break;
          case 'thinking':
            updateLastIfSameKind('thinking', ev.text);
            break;
          case 'tool_call_start': {
            toolStartedAt.set(ev.call.id, Date.now());
            pushItem('tool', `▸ ${ev.call.name}(${truncateArgs(ev.call.arguments)})`);
            break;
          }
          case 'tool_call_done': {
            const startedAt = toolStartedAt.get(ev.call.id);
            toolStartedAt.delete(ev.call.id);
            const elapsed = startedAt ? `  (${formatElapsed(Date.now() - startedAt)})` : '';
            let resultContent: string;
            if (ev.outcome.type === 'ok') {
              pushItem('tool', `  ✓ ${truncate(ev.outcome.summary, 200)}${elapsed}`);
              resultContent = ev.outcome.summary;
            } else {
              pushItem('tool', `  ✗ ${ev.outcome.error.code}: ${ev.outcome.error.message}${elapsed}`);
              resultContent = `error: ${ev.outcome.error.message}`;
              turnToolErrorsRef.current += 1;
            }
            // CRITICAL: every assistant `tool_use` MUST be followed by a
            // matching `tool` message in history. Without this, providers
            // like Anthropic reject the next request with HTTP 400
            // ("tool_use ids were found without tool_result blocks").
            messagesRef.current = [
              ...messagesRef.current,
              {
                role: 'tool',
                content: resultContent,
                toolCallId: ev.call.id,
                name: ev.call.name
              }
            ];
            break;
          }
          case 'turn_end': {
            // Detect a structured question in the assistant's last message.
            const found = tryExtractInteraction(assistantBuffer);
            if (found) {
              setOverlay({ kind: 'option-picker', request: found.request });
              // Rewrite the last assistant transcript line to remove the
              // raw `<atlas:question>...` block — the user gets it as the
              // overlay UI instead.
              const cleaned = found.remaining.trim();
              setTranscript((prev) => {
                if (prev.length === 0) return prev;
                const last = prev[prev.length - 1];
                if (!last || last.kind !== 'assistant') return prev;
                if (cleaned.length === 0) return prev.slice(0, -1);
                return [...prev.slice(0, -1), { ...last, text: cleaned }];
              });
              // Also strip the block from history so subsequent turns
              // don't quote a stale prompt back at the model.
              const sanitized: Message = {
                ...ev.assistantMessage,
                content: stripInteractionBlocks(ev.assistantMessage.content)
              };
              messagesRef.current = [...messagesRef.current, sanitized];
            } else {
              messagesRef.current = [...messagesRef.current, ev.assistantMessage];
              // Safety net: if the model produced visible content but no
              // delta event ever fired (some providers consolidate the
              // final message into thinking blocks only, others batch the
              // text into a single content_block_stop), make sure the
              // user actually sees the reply.
              const visible = renderVisibleAssistant(
                typeof ev.assistantMessage.content === 'string'
                  ? ev.assistantMessage.content
                  : ''
              );
              if (visible.length > 0) {
                setTranscript((prev) => {
                  const last = prev[prev.length - 1];
                  if (last && last.kind === 'assistant' && last.text === visible) {
                    return prev;
                  }
                  if (last && last.kind === 'assistant') {
                    // Replace if delta produced an empty/partial line that
                    // doesn't match the final committed message.
                    if (last.text.length >= visible.length) return prev;
                    return [...prev.slice(0, -1), { ...last, text: visible }];
                  }
                  transcriptKey.current += 1;
                  return [
                    ...prev,
                    {
                      key: `t${transcriptKey.current}`,
                      kind: 'assistant',
                      text: visible,
                      author: assistantAuthor
                    }
                  ];
                });
              }
            }
            assistantBuffer = '';
            // Persist the session after each turn so resuming the
            // conversation later just works. We mutate the record in
            // place (it's a private ref, never read across renders) and
            // fire-and-forget the disk write — sessions are best-effort,
            // a write failure is logged via pushItem but doesn't break
            // the chat loop.
            if (props.sessionStore && sessionRef.current) {
              const rec = sessionRef.current;
              rec.messages = [...messagesRef.current];
              rec.agent = activeAgent.name;
              rec.model = model;
              void props.sessionStore.write(rec).then((r) => {
                if (!r.ok) {
                  // eslint-disable-next-line no-console
                  console.error('session write failed:', r.error.message);
                }
              });
            }
            break;
          }
          case 'done':
            rounds = ev.rounds;
            turnRoundsRef.current = ev.rounds;
            if (ev.usage) {
              totalTokens = ev.usage.totalTokens;
              promptTokens = ev.usage.promptTokens;
              completionTokens = ev.usage.completionTokens;
            }
            setUsage({
              tokens: totalTokens,
              rounds,
              ...(promptTokens !== undefined ? { promptTokens } : {}),
              ...(completionTokens !== undefined ? { completionTokens } : {})
            });
            // Self-improvement heuristic: if this turn was "hard" (many
            // rounds, repeated tool errors, or the user signalled success
            // after a struggle), offer to distill a learned skill.
            // Lightweight detector — the actual reflection is one
            // additional LLM call gated behind user confirmation.
            if (
              learnEnabledRef.current &&
              shouldOfferLearn(
                turnRoundsRef.current,
                turnToolErrorsRef.current,
                lastUserMessageRef.current
              )
            ) {
              const reason = describeLearnReason(
                turnRoundsRef.current,
                turnToolErrorsRef.current,
                lastUserMessageRef.current
              );
              void launchLearnReflection(reason);
            }
            break;
          case 'error':
            if (ev.error.code === 'CANCELLED') {
              pushItem('system', '(cancelled)');
            } else {
              pushItem('error', `[${ev.error.code}] ${ev.error.message}`);
            }
            break;
        }
      }
    },
    [
      streaming,
      activeAgent,
      model,
      agentModels,
      thinking,
      provider,
      props.tools,
      props.toolContext,
      props.skills,
      props.fallbackModels,
      props.agents,
      allAgents,
      app,
      pushItem,
      updateLastIfSameKind,
      switchAgent,
      launchLearnReflection,
      hydrateTranscriptFromMessages
    ]
  );

  // Global keybindings.
  useInput((char, key) => {
    if (key.ctrl && (char === 'c' || char === '\u0003')) {
      handleCtrlC();
      return;
    }
    // Ctrl-D twice exits. Single-press is swallowed (so it doesn't
    // accidentally type EOT bytes into the input).
    if (key.ctrl && (char === 'd' || char === '\u0004')) {
      handleCtrlD();
      return;
    }
    // Ctrl+Y — copy the LATEST fenced code block from the transcript
    // (scanning the full text, not the on-screen slice — long blocks
    // that overflow the window still copy in full) via OSC 52.
    if (key.ctrl && char === 'y') {
      let code: string | null = null;
      for (let i = transcript.length - 1; i >= 0; i -= 1) {
        const it = transcript[i];
        if (!it || it.kind !== 'assistant') continue;
        const found = extractLastCodeBlock(it.text);
        if (found && found.length > 0) {
          code = found;
          break;
        }
      }
      if (code) {
        const b64 = Buffer.from(code, 'utf8').toString('base64');
        process.stdout.write(`\u001b]52;c;${b64}\u0007`);
        pushItem('system', `copied ${code.length} chars (last code block) to clipboard`);
      } else {
        pushItem('system', 'no code block to copy yet');
      }
      return;
    }
    // Scroll the transcript history. PgUp/PgDn move by ~half a screen
    // (using the dynamic row budget computed below); Shift+Up/Down step
    // by one line; End jumps back to the latest output.
    if (key.pageUp) {
      setScrollOffset((o) => o + Math.max(1, Math.floor((rows - 8) / 2)));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((o) => Math.max(0, o - Math.max(1, Math.floor((rows - 8) / 2))));
      return;
    }
    if (key.shift && key.upArrow && overlay.kind === 'none' && input.length === 0) {
      setScrollOffset((o) => o + 1);
      return;
    }
    if (key.shift && key.downArrow && overlay.kind === 'none' && input.length === 0) {
      setScrollOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (overlay.kind !== 'none') {
      // Esc closes any non-blocking overlay (setup, picker, autopilot).
      if (key.escape) {
        // Cancel the AI add-mcp loop if it's running, then close.
        if (overlay.kind === 'mcp-custom-running' && !overlay.finished) {
          aiAddMcpAbortRef.current?.abort();
        }
        // Cancel an in-progress GitHub OAuth device flow.
        if (overlay.kind === 'mcp-add' && overlay.stage === 'oauth-device') {
          githubOauthAbortRef.current?.abort();
        }
        // Cancel an in-flight reflection sub-call.
        if (overlay.kind === 'learn-confirm' && overlay.stage === 'reflecting') {
          reflectAbortRef.current?.abort();
        }
        closeOverlay();
      }
      return;
    }
    // Slash command palette navigation. When the input starts with `/`
    // (and no space yet) Up/Down + Tab cycle the suggestions; the
    // visible match list highlights the active row. Enter / Tab on its
    // own complete the selection (handled in handleInputSubmit).
    const slashMatches = matchSlashCommands(input);
    if (slashMatches.length > 0) {
      if (key.downArrow) {
        setSlashIdx((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (key.upArrow) {
        setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (key.tab && !key.shift) {
        const pick = slashMatches[Math.min(slashIdx, slashMatches.length - 1)];
        if (pick) {
          setInput(`/${pick.name}${pick.args ? ' ' : ''}`);
          setSlashIdx(0);
        }
        return;
      }
    }
    if (key.tab && key.shift) {
      setOverlay({ kind: 'agent-picker' });
      return;
    }
    if (key.tab) {
      cycleAgent();
      return;
    }
    // NB: Ctrl+M is indistinguishable from Enter on most terminals (both
    // produce CR), so we bind the model picker to Ctrl+O instead.
    if (key.ctrl && char === 'o') {
      setOverlay({ kind: 'model-picker' });
      return;
    }
    if (key.ctrl && char === 't') {
      cycleThinking();
      return;
    }
    if (key.ctrl && char === 'p') {
      togglePlanBuild();
      return;
    }
    if (key.escape && streaming) {
      cancelStream();
      return;
    }
  });

  // Overlay handlers
  const closeOverlay = useCallback(() => setOverlay({ kind: 'none' }), []);

  const onPickAgent = useCallback(
    (item: { value: string }) => {
      const next = props.agents.get(item.value);
      if (next) switchAgent(next);
      closeOverlay();
    },
    [props.agents, switchAgent, closeOverlay]
  );

  const onPickModel = useCallback(
    (item: { value: string }) => {
      // Section headers are interleaved with selectable rows so the
      // user can scan provider boundaries — ignore selects on them.
      if (item.value === '__header__') return;
      if (item.value === '__custom__') {
        setInput('');
        setOverlay({ kind: 'model-freeform' });
        return;
      }
      // Item value shape: `<providerKind>:<modelId>` for catalog rows,
      // bare `<modelId>` for legacy / custom rows. Decode and route.
      let providerKind: 'openrouter' | 'anthropic' | 'openai-codex' | 'unknown' = 'unknown';
      let modelId = item.value;
      const sep = item.value.indexOf(':');
      if (sep > 0) {
        const head = item.value.slice(0, sep);
        if (head === 'openrouter' || head === 'anthropic' || head === 'openai-codex') {
          providerKind = head;
          modelId = item.value.slice(sep + 1);
        }
      }
      if (providerKind === 'unknown') {
        providerKind = providerKindFor(modelId, modelCatalog);
      }
      // Branch: when the picker was opened to pin a compaction model
      // (via `/compact model`), assign the selection to the compaction
      // config and persist instead of switching the chat model.
      if (overlay.kind === 'model-picker' && overlay.purpose === 'compact') {
        compactModelRef.current = modelId;
        const baseCfg = props.config;
        if (baseCfg) {
          const next: AtlasConfig = {
            ...baseCfg,
            compaction: { ...baseCfg.compaction, model: modelId }
          };
          void saveConfig(next).then((r) => {
            if (!r.ok) pushItem('error', `save failed: ${r.error.message}`);
          });
        }
        pushItem('system', `compaction model set to ${modelId}.`);
        closeOverlay();
        return;
      }
      // Swap to the matching provider instance if we have one for that
      // kind. If not (e.g. user picked a Codex model but Codex provider
      // isn't wired yet), refuse the switch entirely so we don't send
      // OpenAI ids to the Anthropic endpoint and 404.
      const next = props.providers?.[providerKind as 'openrouter' | 'anthropic' | 'openai-codex'];
      if (!next) {
        pushItem(
          'system',
          providerKind === 'unknown'
            ? `Cannot switch to ${modelId}: no provider matches this model id.`
            : `Cannot switch to ${modelId}: ${providerKind} is not connected.\nSign in via /config first, then try again.`
        );
        closeOverlay();
        return;
      }
      setProvider(next);
      setActiveProviderKind(providerKind as 'openrouter' | 'anthropic' | 'openai-codex');
      setModel(modelId);
      pushItem('system', `model → ${modelId}`);
      closeOverlay();
    },
    [pushItem, closeOverlay, props.providers, props.config, modelCatalog, overlay]
  );

  const onCustomModelSubmit = useCallback(
    (raw: string): void => {
      const id = raw.trim();
      if (id.length === 0) {
        closeOverlay();
        return;
      }
      // Route to the right provider (id-shape heuristic + catalog hit).
      // Without this, a custom OpenRouter id like `moonshotai/kimi-k2.6`
      // would stay pinned to whatever provider happened to be active
      // (e.g. Anthropic via Claude Code OAuth) and 401.
      const providerKind = providerKindFor(id, modelCatalog);
      const next =
        providerKind === 'unknown'
          ? undefined
          : props.providers?.[providerKind];
      if (!next) {
        pushItem(
          'system',
          providerKind === 'unknown'
            ? `Cannot use ${id}: no provider matches this model id (try prefixing with vendor/, e.g. openai/gpt-5).`
            : `Cannot use ${id}: ${providerKind} is not connected. Sign in via /config first.`
        );
        closeOverlay();
        return;
      }
      let added = false;
      // Dedup against built-in seed/catalog: a "custom" id that already
      // ships as a default doesn't need to be saved separately — it'll
      // appear in the picker either way and "(custom)" wording is gone.
      const seedSet = new Set<string>([
        ...(props.availableModels ?? []),
        ...(props.fallbackModels ?? []),
        props.defaultModel,
        ...(modelCatalog?.map((m) => m.id) ?? [])
      ]);
      const isBuiltin = seedSet.has(id);
      setExtraModels((prev) => {
        if (prev.includes(id)) return prev;
        if (isBuiltin) return prev;
        added = true;
        return [...prev, id];
      });
      setProvider(next);
      setActiveProviderKind(providerKind);
      setModel(id);
      pushItem('system', `model → ${id}`);
      setInput('');
      closeOverlay();
      // Persist user-added model ids to ~/.atlas/config.yaml so they
      // survive restarts. Only OpenRouter ids are persisted (Anthropic
      // / Codex catalogs are fixed by the provider).
      const cfg = props.config;
      if (added && cfg && providerKind === 'openrouter') {
        const existing = cfg.providers.openrouter.customModels ?? [];
        if (!existing.includes(id)) {
          const nextCfg: AtlasConfig = {
            ...cfg,
            providers: {
              ...cfg.providers,
              openrouter: {
                ...cfg.providers.openrouter,
                customModels: [...existing, id]
              }
            }
          };
          void saveConfig(nextCfg).then((r) => {
            if (!r.ok) {
              pushItem('error', `failed to persist custom model: ${r.error.message}`);
            }
          });
        }
      }
    },
    [
      pushItem,
      closeOverlay,
      props.config,
      modelCatalog,
      props.providers,
      props.availableModels,
      props.fallbackModels,
      props.defaultModel
    ]
  );

  const onOnboardModePick = useCallback(
    (item: { value: string }) => {
      if (overlay.kind !== 'onboard' || overlay.stage !== 'mode') return;
      const mode = item.value as OnboardMode;
      const draft: OnboardDraft = { ...overlay.draft, mode };
      if (mode === 'map-only') {
        setOverlay({ kind: 'onboard', stage: 'confirm', draft });
        return;
      }
      if (mode === 'full') {
        setOverlay({ kind: 'onboard', stage: 'confirm', draft: { ...draft, strategy: 'same-model' } });
        return;
      }
      setOverlay({ kind: 'onboard', stage: 'strategy', draft });
    },
    [overlay]
  );

  const onOnboardStrategyPick = useCallback(
    (item: { value: string }) => {
      if (overlay.kind !== 'onboard' || overlay.stage !== 'strategy') return;
      const strategy = item.value as OnboardStrategy;
      const draft: OnboardDraft = { ...overlay.draft, strategy };
      if (strategy === 'same-model') {
        setOverlay({ kind: 'onboard', stage: 'pick-model', draft, target: 'same' });
        return;
      }
      if (strategy === 'cheap-fallback') {
        setOverlay({ kind: 'onboard', stage: 'pick-model', draft, target: 'cheap' });
        return;
      }
      setOverlay({ kind: 'onboard', stage: 'pick-model', draft, target: 'map' });
    },
    [overlay]
  );

  const onOnboardPickModel = useCallback(
    (item: { value: string }) => {
      if (overlay.kind !== 'onboard' || overlay.stage !== 'pick-model') return;
      const chosen = item.value;
      const d = overlay.draft;
      if (overlay.target === 'same') {
        setOverlay({ kind: 'onboard', stage: 'confirm', draft: { ...d, sameModel: chosen } });
        return;
      }
      if (overlay.target === 'cheap') {
        setOverlay({ kind: 'onboard', stage: 'pick-model', draft: { ...d, cheapModel: chosen }, target: 'fallback' });
        return;
      }
      if (overlay.target === 'fallback') {
        setOverlay({ kind: 'onboard', stage: 'confirm', draft: { ...d, fallbackModel: chosen } });
        return;
      }
      if (overlay.target === 'map') {
        setOverlay({
          kind: 'onboard',
          stage: 'pick-model',
          draft: {
            ...d,
            stageModels: {
              ...(d.stageModels ?? { map: chosen, architecture: chosen, onboarding: chosen }),
              map: chosen
            }
          },
          target: 'architecture'
        });
        return;
      }
      if (overlay.target === 'architecture') {
        setOverlay({
          kind: 'onboard',
          stage: 'pick-model',
          draft: {
            ...d,
            stageModels: {
              ...(d.stageModels ?? { map: chosen, architecture: chosen, onboarding: chosen }),
              architecture: chosen
            }
          },
          target: 'onboarding'
        });
        return;
      }
      setOverlay({
        kind: 'onboard',
        stage: 'confirm',
        draft: {
          ...d,
          stageModels: {
            ...(d.stageModels ?? { map: chosen, architecture: chosen, onboarding: chosen }),
            onboarding: chosen
          }
        }
      });
    },
    [overlay]
  );

  const executeOnboard = useCallback(async (): Promise<void> => {
    if (overlay.kind !== 'onboard' || overlay.stage !== 'confirm') return;
    const draft = overlay.draft;
    setOverlay({ kind: 'onboard', stage: 'running', draft, status: 'writing repo map...' });

    const mapR = await writeRepoMap({ cwd: process.cwd() });
    if (!mapR.ok) {
      pushItem('error', `onboard failed: ${mapR.error.message}`);
      setOverlay({ kind: 'none' });
      return;
    }
    pushItem('system', `repo map written → ${mapR.value.path}`);

    if (draft.mode === 'map-only') {
      pushItem('system', 'map-only complete. Use /next to continue orchestration.');
      setOverlay({ kind: 'none' });
      return;
    }

    const pickModel =
      draft.strategy === 'same-model'
        ? draft.sameModel
        : draft.strategy === 'cheap-fallback'
          ? draft.cheapModel
          : draft.stageModels?.architecture;
    if (pickModel && pickModel !== model) {
      setModel(pickModel);
      pushItem('system', `model → ${pickModel} (onboard plan)`);
    }

    const planLine =
      draft.strategy === 'same-model'
        ? `single-model: ${draft.sameModel ?? model}`
        : draft.strategy === 'cheap-fallback'
          ? `cheap+fallback: ${draft.cheapModel ?? model} -> ${draft.fallbackModel ?? model}`
          : `manual per-stage: map=${draft.stageModels?.map ?? model}, architecture=${draft.stageModels?.architecture ?? model}, onboarding=${draft.stageModels?.onboarding ?? model}`;

    setOverlay({ kind: 'none' });
    void submit(
      [
        '*onboard',
        `Mode: ${draft.mode}`,
        `Strategy: ${planLine}`,
        `Estimated tokens: input~${draft.preflight.estimatedInputTokens}, output~${draft.preflight.estimatedOutputTokensMin}-${draft.preflight.estimatedOutputTokensMax}, band=${draft.preflight.costBand}`,
        'Use docs/repo-map.md as source-of-truth and produce:',
        '- docs/brownfield-architecture.md',
        '- docs/onboarding.md',
        'Also seed .atlas/state.yaml artifacts when confidently inferable.',
        'If confidence is low in any section, explicitly mark assumptions.'
      ].join('\n')
    );
  }, [overlay, pushItem, submit, model]);

  const onboardCostLabel = useCallback((d: OnboardDraft): string => {
    const p = d.preflight;
    return `${p.costBand.toUpperCase()} · in ~${p.estimatedInputTokens} tok · out ~${p.estimatedOutputTokensMin}-${p.estimatedOutputTokensMax}`;
  }, []);

  const onPickOption = useCallback(
    (item: { value: string }) => {
      if (item.value === '__freeform__' && overlay.kind === 'option-picker') {
        // Reset the textbox so the freeform overlay starts blank — it
        // shares the main `input` state, so leftover text would leak in.
        setInput('');
        setOverlay({ kind: 'option-freeform', request: overlay.request });
        return;
      }
      closeOverlay();
      void submit(item.value);
    },
    [overlay, submit, closeOverlay]
  );

  const onFreeformSubmit = useCallback(
    (value: string) => {
      // Always clear the shared input state so it doesn't reappear in
      // the main chat textbox when the overlay closes.
      setInput('');
      closeOverlay();
      void submit(value);
    },
    [submit, closeOverlay]
  );

  const handleInputSubmit = useCallback(
    (value: string) => {
      // If the slash palette has matches, Enter "selects" the highlighted
      // one — for a bare `/`, Up/Down + Enter is faster than typing the
      // command name. We rewrite `value` to the full canonical command,
      // then forward to submit() so /help, /exit, etc. fire normally.
      const matches = matchSlashCommands(value);
      let resolved = value;
      if (matches.length > 0) {
        const pick = matches[Math.min(slashIdx, matches.length - 1)];
        if (pick) {
          // Preserve any trailing args the user already typed past the
          // command name (defensive — matchSlashCommands suppresses on
          // space, so `value` won't contain one yet).
          resolved = `/${pick.name}`;
        }
      }
      setInput('');
      setSlashIdx(0);
      void submit(resolved);
    },
    [submit, slashIdx]
  );

  // Reset the slash-palette cursor whenever the input no longer looks
  // like a slash command, so the next `/` starts fresh at the top.
  useEffect(() => {
    if (!input.startsWith('/')) setSlashIdx(0);
    else {
      const matches = matchSlashCommands(input);
      if (slashIdx >= matches.length) setSlashIdx(0);
    }
    // We intentionally do not depend on slashIdx to avoid a feedback loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  const onAutopilotConsent = useCallback(
    (item: { value: string }) => {
      closeOverlay();
      if (item.value === 'yes') {
        setAutopilotConsented(true);
        setMode('autopilot');
        pushItem(
          'system',
          'Autopilot enabled. Atlas will use any tool without asking for the rest of this session.'
        );
      } else {
        pushItem('system', 'Autopilot declined — staying in current mode.');
      }
    },
    [pushItem, closeOverlay]
  );

  // MCP add overlay — pick a curated server suggestion, prompt for any
  // required env vars one at a time, then write to ~/.atlas/config.yaml.
  // The server isn't spawned in-session: that happens at next boot via
  // `runTui.ts`. The user is told to restart.
  const onMcpPick = useCallback(
    (item: { value: string }) => {
      // Custom flow — server isn't in the curated catalog. Open a
      // sub-menu where the user picks between manual instructions or
      // an AI-assisted add.
      if (item.value === '__custom__') {
        setOverlay({ kind: 'mcp-custom-menu' });
        return;
      }
      const sug = findSuggestion(item.value);
      if (!sug) {
        closeOverlay();
        pushItem('error', `unknown MCP suggestion: ${item.value}`);
        return;
      }
      const existing = props.config?.mcp.servers.some((s) => s.name === sug.name);
      if (existing) {
        // Don't error — just route the user to the per-server actions
        // overlay so they can disable / re-enable / remove (or back out).
        setOverlay({ kind: 'mcp-manage', serverName: sug.name });
        return;
      }
      // For stdio entries, verify the prerequisite binary is on PATH.
      // If it isn't, show a dedicated overlay that either offers a
      // safe one-line auto-install (currently only `uv`) or links the
      // user to the docs page for manual install.
      if (sug.transport === 'stdio') {
        void (async () => {
          const found = await findOnPath(sug.prerequisite.bin);
          if (found) {
            advanceMcpAfterPrereq(sug.id);
            return;
          }
          setOverlay({
            kind: 'mcp-add',
            stage: 'prereq',
            suggestionId: sug.id,
            installing: false
          });
        })();
        return;
      }
      advanceMcpAfterPrereq(sug.id);
    },
    [props.config, pushItem, closeOverlay]
  );

  /** Move from prereq-check (or pick) to env-collection / confirm. */
  const advanceMcpAfterPrereq = useCallback(
    (suggestionId: string): void => {
      const sug = findSuggestion(suggestionId);
      if (!sug) {
        closeOverlay();
        return;
      }
      // Stdio entries that declare auth methods (e.g. github) get a
      // chooser before env collection so the user can pick between
      // OAuth-via-`gh` and pasting a PAT.
      if (sug.transport === 'stdio' && sug.authMethods && sug.authMethods.length > 1) {
        setOverlay({
          kind: 'mcp-add',
          stage: 'auth',
          suggestionId: sug.id,
          probing: false
        });
        return;
      }
      if (sug.env.length === 0) {
        setOverlay({
          kind: 'mcp-add',
          stage: 'confirm',
          suggestionId: sug.id,
          collected: {}
        });
      } else {
        setInput('');
        setOverlay({
          kind: 'mcp-add',
          stage: 'env',
          suggestionId: sug.id,
          envIndex: 0,
          draft: '',
          collected: {}
        });
      }
    },
    [closeOverlay]
  );

  // Handle the action chosen on the prereq-missing overlay (install /
  // re-check / open docs / skip).
  const onMcpPrereqAction = useCallback(
    (item: { value: string }) => {
      if (overlay.kind !== 'mcp-add' || overlay.stage !== 'prereq') return;
      const sug = findSuggestion(overlay.suggestionId);
      if (!sug || sug.transport !== 'stdio') {
        closeOverlay();
        return;
      }
      const prereq = sug.prerequisite;
      switch (item.value) {
        case 'skip':
          closeOverlay();
          pushItem('system', `cancelled adding '${sug.name}'.`);
          return;
        case 'docs':
          void openInBrowser(prereq.docsUrl);
          pushItem('system', `Opened ${prereq.docsUrl}. Install, then re-run /mcps add.`);
          closeOverlay();
          return;
        case 'recheck': {
          const id = sug.id;
          void (async () => {
            const found = await findOnPath(prereq.bin);
            if (found) {
              advanceMcpAfterPrereq(id);
            } else {
              setOverlay({
                kind: 'mcp-add',
                stage: 'prereq',
                suggestionId: id,
                installing: false,
                statusLine: `error: '${prereq.bin}' still not on PATH`
              });
            }
          })();
          return;
        }
        case 'install': {
          if (!prereq.autoInstall) return;
          const id = sug.id;
          const shellCmd = prereq.autoInstall.shell;
          setOverlay({
            kind: 'mcp-add',
            stage: 'prereq',
            suggestionId: id,
            installing: true
          });
          void (async () => {
            const isWin = platform() === 'win32';
            const child = spawn(isWin ? 'cmd' : 'sh', isWin ? ['/c', shellCmd] : ['-c', shellCmd], {
              stdio: 'ignore'
            });
            child.on('exit', (code) => {
              void (async () => {
                if (code !== 0) {
                  setOverlay({
                    kind: 'mcp-add',
                    stage: 'prereq',
                    suggestionId: id,
                    installing: false,
                    statusLine: `error: installer exited ${code}`
                  });
                  return;
                }
                const found = await findOnPath(prereq.bin);
                if (found) {
                  pushItem('system', `installed: ${found}`);
                  advanceMcpAfterPrereq(id);
                } else {
                  setOverlay({
                    kind: 'mcp-add',
                    stage: 'prereq',
                    suggestionId: id,
                    installing: false,
                    statusLine: `error: still not on PATH after install (you may need to restart your shell)`
                  });
                }
              })();
            });
            child.on('error', (err) => {
              setOverlay({
                kind: 'mcp-add',
                stage: 'prereq',
                suggestionId: id,
                installing: false,
                statusLine: `error: ${err.message}`
              });
            });
          })();
          return;
        }
      }
    },
    [overlay, closeOverlay, pushItem, advanceMcpAfterPrereq]
  );

  // AbortController for the running GitHub OAuth device flow. Declared
  // above onMcpAuthSelect so the callback can reference launchGithubDeviceFlow.
  const githubOauthAbortRef = useRef<AbortController | null>(null);

  const launchGithubDeviceFlow = useCallback(
    (suggestionId: string): void => {
      const sug = findSuggestion(suggestionId);
      if (!sug || sug.transport !== 'stdio' || !sug.oauthEnvKey) {
        closeOverlay();
        return;
      }
      const envKey = sug.oauthEnvKey;
      const ctrl = new AbortController();
      githubOauthAbortRef.current?.abort();
      githubOauthAbortRef.current = ctrl;
      setOverlay({
        kind: 'mcp-add',
        stage: 'oauth-device',
        suggestionId,
        statusLine: 'requesting device code\u2026',
        statusKind: 'pending'
      });
      void (async (): Promise<void> => {
        try {
          for await (const ev of runGithubDeviceFlow({ signal: ctrl.signal })) {
            if (ctrl.signal.aborted) return;
            if (ev.type === 'code') {
              void openInBrowser(ev.verificationUri);
              setOverlay({
                kind: 'mcp-add',
                stage: 'oauth-device',
                suggestionId,
                userCode: ev.userCode,
                verificationUri: ev.verificationUri,
                statusLine: `opened ${ev.verificationUri} \u2014 enter the code and click Authorize (waiting\u2026)`,
                statusKind: 'pending'
              });
              continue;
            }
            if (ev.type === 'polling') {
              setOverlay((cur) =>
                cur.kind === 'mcp-add' && cur.stage === 'oauth-device'
                  ? {
                      ...cur,
                      statusLine: `waiting for you to authorize in the browser\u2026 (${ev.elapsedSeconds}s)`,
                      statusKind: 'pending'
                    }
                  : cur
              );
              continue;
            }
            if (ev.type === 'authorized') {
              pushItem(
                'system',
                `GitHub OAuth authorized (${ev.accessToken.length}-char token, scopes: ${ev.scope}).`
              );
              setOverlay({
                kind: 'mcp-add',
                stage: 'confirm',
                suggestionId,
                collected: { [envKey]: ev.accessToken }
              });
              return;
            }
            if (ev.type === 'denied') {
              setOverlay({
                kind: 'mcp-add',
                stage: 'auth',
                suggestionId,
                probing: false,
                statusLine: 'error: authorization denied in browser. Pick another method or retry.'
              });
              return;
            }
            if (ev.type === 'expired') {
              setOverlay({
                kind: 'mcp-add',
                stage: 'auth',
                suggestionId,
                probing: false,
                statusLine: 'error: device code expired. Pick OAuth again to start a new code.'
              });
              return;
            }
            if (ev.type === 'cancelled') {
              return;
            }
            if (ev.type === 'error') {
              setOverlay((cur) =>
                cur.kind === 'mcp-add' && cur.stage === 'oauth-device'
                  ? { ...cur, statusLine: `error: ${ev.message}`, statusKind: 'error' }
                  : cur
              );
            }
          }
        } catch (e) {
          if (ctrl.signal.aborted) return;
          const msg = e instanceof Error ? e.message : String(e);
          setOverlay({
            kind: 'mcp-add',
            stage: 'auth',
            suggestionId,
            probing: false,
            statusLine: `error: ${msg}`
          });
        }
      })();
    },
    [closeOverlay, pushItem]
  );

  // Handle the choice on the auth-method picker (currently github only:
  // "OAuth via gh" vs "Personal Access Token" vs cancel).
  const onMcpAuthSelect = useCallback(
    (item: { value: string }) => {
      if (overlay.kind !== 'mcp-add' || overlay.stage !== 'auth') return;
      const sug = findSuggestion(overlay.suggestionId);
      if (!sug || sug.transport !== 'stdio') {
        closeOverlay();
        return;
      }
      const id = sug.id;
      switch (item.value) {
        case 'cancel':
          closeOverlay();
          pushItem('system', `cancelled adding '${sug.name}'.`);
          return;
        case 'pat': {
          // Hand off to the existing env-collection flow.
          if (sug.env.length === 0) {
            setOverlay({ kind: 'mcp-add', stage: 'confirm', suggestionId: id, collected: {} });
          } else {
            setInput('');
            setOverlay({
              kind: 'mcp-add',
              stage: 'env',
              suggestionId: id,
              envIndex: 0,
              draft: '',
              collected: {}
            });
          }
          return;
        }
        case 'docs':
          void openInBrowser('https://cli.github.com');
          pushItem(
            'system',
            'Opened https://cli.github.com. Install gh, run `gh auth login`, then re-pick OAuth.'
          );
          return;
        case 'oauth-browser': {
          // For github we run a real OAuth Device Flow: the user opens
          // the browser, signs in once, types the displayed code, and
          // clicks "Authorize" — atlas captures the token via polling.
          // Nothing to copy/paste.
          if (sug.id === 'github') {
            launchGithubDeviceFlow(id);
            return;
          }
          // Fallback for any future suggestion that just wants to open
          // a token-creation page and have the user paste the result.
          if (!sug.oauthBrowserUrl) {
            setOverlay({
              kind: 'mcp-add',
              stage: 'auth',
              suggestionId: id,
              probing: false,
              statusLine: 'error: no oauthBrowserUrl configured for this entry'
            });
            return;
          }
          void openInBrowser(sug.oauthBrowserUrl);
          pushItem(
            'system',
            `Opened ${sug.oauthBrowserUrl}. Review scopes, generate the token, then paste it on the next screen.`
          );
          // Skip straight to env collection (token paste).
          if (sug.env.length === 0) {
            setOverlay({ kind: 'mcp-add', stage: 'confirm', suggestionId: id, collected: {} });
          } else {
            setInput('');
            setOverlay({
              kind: 'mcp-add',
              stage: 'env',
              suggestionId: id,
              envIndex: 0,
              draft: '',
              collected: {}
            });
          }
          return;
        }
        case 'oauth-gh': {
          const envKey = sug.oauthEnvKey;
          if (!envKey) {
            setOverlay({
              kind: 'mcp-add',
              stage: 'auth',
              suggestionId: id,
              probing: false,
              statusLine: 'error: this entry has no oauthEnvKey configured'
            });
            return;
          }
          setOverlay({ kind: 'mcp-add', stage: 'auth', suggestionId: id, probing: true });
          void (async () => {
            const ghPath = await findOnPath('gh');
            if (!ghPath) {
              setOverlay({
                kind: 'mcp-add',
                stage: 'auth',
                suggestionId: id,
                probing: false,
                statusLine: 'error: `gh` CLI not on PATH. Install it first (cli.github.com), then sign in with `gh auth login`.'
              });
              return;
            }
            // Capture token from `gh auth token`. Quietly times out
            // after 5s so a hung gh process can't lock the TUI.
            const token = await new Promise<string | null>((resolve) => {
              const child = spawn(ghPath, ['auth', 'token'], { stdio: ['ignore', 'pipe', 'pipe'] });
              let out = '';
              let err = '';
              const timer = setTimeout(() => {
                child.kill('SIGTERM');
                resolve(null);
              }, 5000);
              child.stdout.on('data', (d: Buffer) => {
                out += d.toString('utf8');
              });
              child.stderr.on('data', (d: Buffer) => {
                err += d.toString('utf8');
              });
              child.on('error', () => {
                clearTimeout(timer);
                resolve(null);
              });
              child.on('exit', (code) => {
                clearTimeout(timer);
                if (code === 0) {
                  resolve(out.trim());
                } else {
                  resolve(err.trim().length > 0 ? `__error__:${err.trim()}` : null);
                }
              });
            });
            if (!token || token.startsWith('__error__:') || token.length === 0) {
              const detail = token && token.startsWith('__error__:') ? token.slice('__error__:'.length) : 'no token returned';
              setOverlay({
                kind: 'mcp-add',
                stage: 'auth',
                suggestionId: id,
                probing: false,
                statusLine: `error: gh auth token failed (${detail}). Run \`gh auth login\` and retry.`
              });
              return;
            }
            // Got a token — jump straight to confirm with it pre-collected.
            setOverlay({
              kind: 'mcp-add',
              stage: 'confirm',
              suggestionId: id,
              collected: { [envKey]: token }
            });
            pushItem('system', `Pulled OAuth token from \`gh auth token\` (${token.length} chars).`);
          })();
          return;
        }
      }
    },
    [overlay, closeOverlay, pushItem, launchGithubDeviceFlow]
  );

  const onMcpEnvSubmit = useCallback(() => {
    if (overlay.kind !== 'mcp-add' || overlay.stage !== 'env') return;
    const sug = findSuggestion(overlay.suggestionId);
    if (!sug) {
      closeOverlay();
      return;
    }
    const spec = sug.env[overlay.envIndex];
    if (!spec) {
      closeOverlay();
      return;
    }
    const value = input.trim();
    if (spec.required && value.length === 0) {
      pushItem('error', `${spec.key} is required.`);
      return;
    }
    const collected: Record<string, string> = { ...overlay.collected };
    if (value.length > 0) collected[spec.key] = value;
    const nextIndex = overlay.envIndex + 1;
    setInput('');
    if (nextIndex >= sug.env.length) {
      setOverlay({
        kind: 'mcp-add',
        stage: 'confirm',
        suggestionId: sug.id,
        collected
      });
    } else {
      setOverlay({
        kind: 'mcp-add',
        stage: 'env',
        suggestionId: sug.id,
        envIndex: nextIndex,
        draft: '',
        collected
      });
    }
  }, [overlay, input, pushItem, closeOverlay]);

  const onMcpConfirm = useCallback(
    (item: { value: string }) => {
      if (overlay.kind !== 'mcp-add' || overlay.stage !== 'confirm') return;
      if (item.value !== 'yes') {
        closeOverlay();
        pushItem('system', 'MCP add cancelled.');
        return;
      }
      const sug = findSuggestion(overlay.suggestionId);
      if (!sug) {
        closeOverlay();
        return;
      }
      void (async (): Promise<void> => {
        const baseCfg = props.config;
        if (!baseCfg) {
          pushItem('error', 'no config loaded — run /config first');
          closeOverlay();
          return;
        }
        const collected = overlay.collected;
        // For stdio entries, resolve the command to an absolute path
        // when possible. findOnPath also probes ~/.local/bin (where our
        // auto-installer drops binaries) so the spawned MCP server
        // works even if the user's shell hasn't picked up that dir on
        // PATH yet. Falls back to the bare name if not found — the
        // user gets a clear "command not found" error at startup
        // instead of silent failure.
        let resolvedCommand = sug.transport === 'stdio' ? sug.command : '';
        if (sug.transport === 'stdio') {
          const abs = await findOnPath(sug.command);
          if (abs) resolvedCommand = abs;
        }
        const newServer =
          sug.transport === 'http'
            ? {
                transport: 'http' as const,
                name: sug.name,
                url: sug.url,
                headers: renderHeaders(sug.headerTemplate, collected),
                args: [],
                env: {},
                enabled: true
              }
            : {
                transport: 'stdio' as const,
                name: sug.name,
                command: resolvedCommand,
                args: [...sug.args],
                env: collected,
                headers: {},
                enabled: true
              };
        const next: AtlasConfig = {
          ...baseCfg,
          mcp: {
            ...baseCfg.mcp,
            servers: [...baseCfg.mcp.servers, newServer]
          }
        };
        const saved = await saveConfig(next);
        if (!saved.ok) {
          pushItem('error', `failed to save config: ${saved.error.message}`);
          closeOverlay();
          return;
        }
        pushItem(
          'system',
          `Added MCP server '${sug.name}' to ${saved.value.path}.`
        );
        // Surface a dedicated restart prompt — the chat-line message
        // is easy to miss in a busy transcript and users were asking
        // "where do I see this?". The overlay forces an explicit
        // ack and gives a one-keystroke quit.
        setOverlay({
          kind: 'mcp-restart-prompt',
          serverName: sug.name,
          configPath: saved.value.path
        });
      })();
    },
    [overlay, props.config, pushItem, closeOverlay]
  );

  // Setup overlay: paste API key inside the TUI, persist to ~/.atlas/config.yaml,
  // then materialize a real provider so the next /send works.
  // Shared helpers used by the `mcp-list` / `mcp-manage` overlays.
  // Each returns a status line to surface in-overlay; callers also
  // push a transcript line so the action is visible after closing.
  const builtinNames = useMemo(
    () => new Set(DEFAULT_BUILTIN_MCP_SERVERS.map((s) => s.name)),
    []
  );
  const setMcpEnabled = useCallback(
    async (name: string, enable: boolean): Promise<string> => {
      const baseCfg = props.config;
      if (!baseCfg) return 'error: no config loaded';
      const found = baseCfg.mcp.servers.find((s) => s.name === name);
      if (!found) return `error: no such server '${name}'`;
      if (found.enabled === enable) return `already ${enable ? 'enabled' : 'disabled'}`;
      const next: AtlasConfig = {
        ...baseCfg,
        mcp: {
          ...baseCfg.mcp,
          servers: baseCfg.mcp.servers.map((s) => (s.name === name ? { ...s, enabled: enable } : s))
        }
      };
      const saved = await saveConfig(next);
      if (!saved.ok) return `error: ${saved.error.message}`;
      pushItem(
        'system',
        `${enable ? 'Enabled' : 'Disabled'} MCP server '${name}'. Restart atlas for the change to take effect.`
      );
      return `\u2713 ${enable ? 'enabled' : 'disabled'} \u2014 restart atlas to apply`;
    },
    [props.config, pushItem]
  );
  const removeMcp = useCallback(
    async (name: string): Promise<string> => {
      const baseCfg = props.config;
      if (!baseCfg) return 'error: no config loaded';
      if (builtinNames.has(name)) return `error: '${name}' is a built-in (disable instead of removing)`;
      const before = baseCfg.mcp.servers.length;
      const next: AtlasConfig = {
        ...baseCfg,
        mcp: {
          ...baseCfg.mcp,
          servers: baseCfg.mcp.servers.filter((s) => s.name !== name)
        }
      };
      if (next.mcp.servers.length === before) return `error: no such server '${name}'`;
      const saved = await saveConfig(next);
      if (!saved.ok) return `error: ${saved.error.message}`;
      pushItem(
        'system',
        `Removed MCP server '${name}'. Restart atlas for the change to take effect.`
      );
      return `\u2713 removed \u2014 restart atlas to apply`;
    },
    [props.config, pushItem, builtinNames]
  );

  // AbortController for the running AI add-mcp harness, so Esc can
  // cancel without leaving the loop streaming in the background.
  const aiAddMcpAbortRef = useRef<AbortController | null>(null);

  const launchAiAddMcp = useCallback(
    (userPrompt: string): void => {
      const trimmed = userPrompt.trim();
      if (!trimmed) return;
      if (!provider) {
        pushItem('error', 'no provider configured \u2014 run /setup first');
        closeOverlay();
        return;
      }
      const cfg = props.config;
      if (!cfg) {
        pushItem('error', 'no config loaded');
        closeOverlay();
        return;
      }
      const ctrl = new AbortController();
      aiAddMcpAbortRef.current?.abort();
      aiAddMcpAbortRef.current = ctrl;
      setOverlay({
        kind: 'mcp-custom-running',
        userPrompt: trimmed,
        events: [],
        currentText: '',
        finished: false
      });
      void (async (): Promise<void> => {
        let added: { name: string; path: string } | null = null;
        try {
          for await (const ev of runAiAddMcp({
            provider,
            model,
            userPrompt: trimmed,
            currentConfig: cfg,
            signal: ctrl.signal
          })) {
            if (ctrl.signal.aborted) return;
            setOverlay((cur) =>
              cur.kind === 'mcp-custom-running'
                ? {
                    ...cur,
                    events: [...cur.events, ev],
                    currentText:
                      ev.type === 'text' ? cur.currentText + ev.text : cur.currentText
                  }
                : cur
            );
            if (ev.type === 'added') {
              added = { name: ev.serverName, path: ev.configPath };
            }
            if (ev.type === 'error') {
              setOverlay((cur) =>
                cur.kind === 'mcp-custom-running'
                  ? { ...cur, finished: true, error: ev.message }
                  : cur
              );
              return;
            }
            if (ev.type === 'done') {
              setOverlay((cur) =>
                cur.kind === 'mcp-custom-running' ? { ...cur, finished: true } : cur
              );
              break;
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setOverlay((cur) =>
            cur.kind === 'mcp-custom-running' ? { ...cur, finished: true, error: msg } : cur
          );
          return;
        }
        if (added) {
          pushItem('system', `AI helper added MCP server '${added.name}' to ${added.path}.`);
          setOverlay({
            kind: 'mcp-restart-prompt',
            serverName: added.name,
            configPath: added.path
          });
        }
      })();
    },
    [provider, model, props.config, pushItem, closeOverlay]
  );

  const onSetupKeyChange = useCallback(
    (value: string) => {
      if (overlay.kind !== 'setup') return;
      setOverlay({ ...overlay, draftKey: value });
    },
    [overlay]
  );

  const onSetupMenuPick = useCallback(
    async (
      target: 'openrouter' | 'anthropic' | 'claude-code' | 'chatgpt' | 'github' | 'mcp'
    ) => {
      if (target === 'openrouter' || target === 'anthropic') {
        setOverlay({ kind: 'setup', stage: 'key', draftKey: '', target });
        return;
      }
      if (target === 'claude-code') {
        const creds = await loadClaudeCodeCredentials({});
        const expiresLine =
          creds.ok && creds.value.expiresAt !== undefined
            ? `\n  expires: ${new Date(creds.value.expiresAt).toLocaleString()}`
            : '';
        const info = creds.ok
          ? `Claude Code OAuth detected.${expiresLine}\n\nAtlas will use it automatically when the Anthropic\nprovider is selected and no API key is configured.`
          : `No Claude Code credentials found.\n  reason: ${creds.error.message}\n\nInstall + sign in to Claude Code, then re-open this menu.`;
        setOverlay({ kind: 'setup', stage: 'info', draftKey: '', target, infoText: info });
        return;
      }
      if (target === 'chatgpt') {
        // Kick off the PKCE flow. Show the URL in an info panel; the
        // promise resolves when the browser hits our loopback callback.
        const handle = beginCodexLogin({
          openBrowser: async (url) => {
            await openInBrowser(url);
          }
        });
        setOverlay({
          kind: 'setup',
          stage: 'info',
          draftKey: '',
          target,
          infoText:
            'Opening your browser to sign in with ChatGPT…\n\nIf nothing opens, visit:\n  ' +
            handle.authorizeUrl +
            '\n\nWaiting for callback on http://127.0.0.1:1455 …\nPress Esc to cancel.'
        });
        const result = await handle.tokens;
        if (!result.ok) {
          pushItem('error', `ChatGPT login failed: ${result.error.message}`);
          closeOverlay();
          return;
        }
        const baseCfg: AtlasConfig = props.config ?? {
          defaultProvider: 'openrouter',
          defaultModel: model,
          fallbackModels: [],
          providers: {
            openrouter: { baseUrl: 'https://openrouter.ai/api/v1', title: 'Atlas CLI', apiKeys: [], customModels: [] },
            anthropic: {
              baseUrl: 'https://api.anthropic.com',
              useClaudeCodeOauth: true,
              apiKeys: []
            },
            openai: {
              codex: {},
              baseUrl: 'https://chatgpt.com/backend-api/codex'
            }
          },
          mcp: { servers: [], builtinsSeeded: false },
          github: {},
          compaction: { enabled: true, threshold: 0.8, contextTokens: 200_000 },
          guardrails: {
            enabled: true,
            dangerousCommand: true,
            pathSafety: true,
            secretRedaction: true,
            promptInjectionDetector: true,
            extraDeniedPaths: [],
            extraDeniedCommands: []
          }
        };
        const nextCfg: AtlasConfig = {
          ...baseCfg,
          providers: {
            ...baseCfg.providers,
            openai: {
              ...baseCfg.providers.openai,
              codex: {
                accessToken: result.value.accessToken,
                ...(result.value.refreshToken !== undefined
                  ? { refreshToken: result.value.refreshToken }
                  : {}),
                ...(result.value.idToken !== undefined ? { idToken: result.value.idToken } : {}),
                ...(result.value.accountId !== undefined
                  ? { accountId: result.value.accountId }
                  : {}),
                expiresAt: result.value.expiresAt
              }
            }
          }
        };
        const saved = await saveConfig(nextCfg);
        if (!saved.ok) {
          pushItem('error', `failed to save config: ${saved.error.message}`);
          closeOverlay();
          return;
        }
        pushItem(
          'system',
          `Signed in to ChatGPT. Tokens saved to ${saved.value.path}.\nRestart atlas to start chatting with OpenAI models.`
        );
        closeOverlay();
        return;
      }
      if (target === 'github') {
        const info =
          'GitHub OAuth is not yet wired up in this build.\n\nFor now, use the `gh` CLI:\n  1. Install:  brew install gh   (or apt/dnf/winget)\n  2. Sign in:  gh auth login\n\nAtlas will pick up the token from `gh auth token`\nwhen the GitHub tools are invoked.';
        setOverlay({ kind: 'setup', stage: 'info', draftKey: '', target, infoText: info });
        return;
      }
      // mcp
      const info =
        'MCP servers can be added from the suggested catalog with /mcps add\n(or edited directly in ~/.atlas/config.yaml under the `mcp:` key).\n\nUse /mcps to list configured servers and their live tool counts.\nUse /mcps remove <name> to remove one.';
      setOverlay({ kind: 'setup', stage: 'info', draftKey: '', target, infoText: info });
    },
    [props.config, model, pushItem, closeOverlay]
  );

  const onSetupSubmit = useCallback(async () => {
    if (overlay.kind !== 'setup' || overlay.stage !== 'key') return;
    const raw = overlay.draftKey.trim();
    if (raw.length === 0) {
      pushItem('error', 'API key is empty.');
      return;
    }
    const allKeys = raw
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    const key = allKeys[0] ?? '';
    const fallbackKeys = allKeys.slice(1);

    const baseCfg: AtlasConfig = props.config ?? {
      defaultProvider: 'openrouter',
      defaultModel: model,
      fallbackModels: [],
      providers: {
        openrouter: {
          baseUrl: 'https://openrouter.ai/api/v1',
          title: 'Atlas CLI',
          apiKeys: [],
          customModels: []
        },
        anthropic: {
          baseUrl: 'https://api.anthropic.com',
          useClaudeCodeOauth: true,
          apiKeys: []
        },
        openai: {
          codex: {},
          baseUrl: 'https://chatgpt.com/backend-api/codex'
        }
      },
      mcp: { servers: [], builtinsSeeded: false },
      github: {},
      compaction: { enabled: true, threshold: 0.8, contextTokens: 200_000 },
      guardrails: {
        enabled: true,
        dangerousCommand: true,
        pathSafety: true,
        secretRedaction: true,
        promptInjectionDetector: true,
        extraDeniedPaths: [],
        extraDeniedCommands: []
      }
    };

    const target = overlay.target;
    const nextCfg: AtlasConfig =
      target === 'anthropic'
        ? {
            ...baseCfg,
            defaultProvider: 'anthropic',
            providers: {
              ...baseCfg.providers,
              anthropic: {
                ...baseCfg.providers.anthropic,
                apiKey: key,
                apiKeys: fallbackKeys
              }
            }
          }
        : {
            ...baseCfg,
            defaultModel: model,
            providers: {
              ...baseCfg.providers,
              openrouter: {
                ...baseCfg.providers.openrouter,
                apiKey: key,
                apiKeys: fallbackKeys
              }
            }
          };

    const saved = await saveConfig(nextCfg);
    if (!saved.ok) {
      pushItem('error', `failed to save config: ${saved.error.message}`);
      return;
    }

    const fallbackNote =
      fallbackKeys.length > 0 ? ` (+ ${fallbackKeys.length} fallback)` : '';

    if (target === 'anthropic') {
      pushItem(
        'system',
        `Anthropic key saved${fallbackNote} to ${saved.value.path}. Restart atlas to switch providers.`
      );
      closeOverlay();
      return;
    }

    const next = createOpenRouterProvider({
      apiKey: key,
      ...(fallbackKeys.length > 0 ? { fallbackKeys } : {}),
      baseUrl: nextCfg.providers.openrouter.baseUrl,
      title: nextCfg.providers.openrouter.title
    });
    setProvider(next);
    closeOverlay();
    pushItem(
      'system',
      `OpenRouter key saved${fallbackNote} to ${saved.value.path}. You're ready to chat.`
    );
  }, [overlay, props.config, model, pushItem, closeOverlay]);

  // Render
  // Reserve rows for the sticky header (3), input (3), status (1), splash (~6 when present),
  // slash autocomplete (~10 when active), and any active overlay (varies by kind).
  // The transcript gets whatever's left, measured in *rendered terminal rows*
  // (not item count) so multi-line tool output / assistant text can't push
  // overlays off-screen.
  const overlayReserve = ((): number => {
    switch (overlay.kind) {
      case 'setup':
        // Menu has 6 rows + title + hint + borders + margins ≈ 14.
        // Key/info stages need a bit more for the input/help block.
        return overlay.stage === 'menu' ? 14 : 16;
      case 'agent-picker':
      case 'model-picker':
        return 16;
      case 'model-freeform':
      case 'option-freeform':
        return 6;
      case 'option-picker':
        return 10;
      case 'autopilot-consent':
        return 14;
      case 'mcp-restart-prompt':
        return 12;
      case 'mcp-list':
        return 16;
      case 'mcp-manage':
        return 14;
      case 'mcp-custom-menu':
        return 12;
      case 'mcp-custom-prompt':
        return 12;
      case 'mcp-custom-running':
        return 18;
      case 'none':
      default:
        return 0;
    }
  })();
  const reserved =
    3 /* header */ +
    3 /* input box */ +
    1 /* status */ +
    (transcript.length === 0 && overlay.kind !== 'setup' ? 6 : 0) +
    (overlay.kind === 'none' && !streaming && input.startsWith('/') ? 10 : 0) +
    overlayReserve;
  const transcriptRowBudget = Math.max(2, rows - reserved);
  // Estimate rendered height of each transcript item by counting hard
  // newlines and wrapping long lines against the terminal width.
  const wrapWidth = Math.max(20, cols - 4);
  const wrappedLineCount = (text: string): number => {
    const lines = text.length === 0 ? [''] : text.split('\n');
    let n = 0;
    for (const line of lines) {
      const visible = line.replace(/\u0001/g, '');
      n += Math.max(1, Math.ceil(visible.length / wrapWidth));
    }
    return n;
  };
  const rowsForItem = (item: TranscriptItem): number => {
    let n = wrappedLineCount(item.text ?? '');
    if (item.kind === 'assistant' || item.kind === 'thinking') n += 1;
    // user/assistant are wrapped in a bordered box: top border + author
    // label + bottom border + marginTop = 4 extra rows.
    if (item.kind === 'user' || item.kind === 'assistant') n += 4;
    return n;
  };
  // Slice an item's text to keep only the LAST `keepRows` rendered rows.
  // Used when the topmost visible item alone exceeds the row budget so
  // it doesn't spill past the box and overlap overlays/header.
  const sliceItemTail = (item: TranscriptItem, keepRows: number): TranscriptItem => {
    const text = item.text ?? '';
    if (keepRows <= 0) return { ...item, text: '… (truncated)' };
    const lines = text.split('\n');
    // Walk lines bottom-up, expanding any that wrap to multiple rows.
    const kept: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const ln = lines[i] ?? '';
      const visible = ln.replace(/\u0001/g, '');
      const h = Math.max(1, Math.ceil(visible.length / wrapWidth));
      if (used + h > keepRows && kept.length > 0) break;
      kept.unshift(ln);
      used += h;
      if (used >= keepRows) break;
    }
    const sliced = kept.join('\n');
    return { ...item, text: `… (truncated)\n${sliced}` };
  };

  // Compute total rendered rows so we know how far the user can scroll.
  let totalRows = 0;
  for (const it of transcript) totalRows += rowsForItem(it);
  const maxOffset = Math.max(0, totalRows - transcriptRowBudget);
  const offset = Math.min(scrollOffset, maxOffset);
  // Window is [endRow - budget, endRow) measured from the top.
  const endRow = totalRows - offset;
  const startRow = Math.max(0, endRow - transcriptRowBudget);
  // Walk items, accumulating row positions, slicing the boundary items
  // so we render exactly the rows in [startRow, endRow).
  const visibleTranscript: TranscriptItem[] = [];
  let cursor = 0;
  for (const it of transcript) {
    const h = rowsForItem(it);
    const itemStart = cursor;
    const itemEnd = cursor + h;
    cursor = itemEnd;
    if (itemEnd <= startRow) continue; // entirely above window
    if (itemStart >= endRow) break; // entirely below window
    let view = it;
    // If the item is partially above the top of the window, drop the
    // overflowing rows from its head.
    if (itemStart < startRow) {
      const keep = itemEnd - startRow;
      view = sliceItemTail(view, keep);
    }
    // If it extends past the bottom of the window, drop overflow rows
    // from its tail. Combined with the head trim above this guarantees
    // the rendered slice fits exactly in the window.
    if (itemEnd > endRow) {
      const dropTail = itemEnd - endRow;
      const text = view.text ?? '';
      const lines = text.split('\n');
      const kept: string[] = [];
      let usedRows = 0;
      const keepRows = wrappedLineCount(text) - dropTail;
      for (const ln of lines) {
        if (usedRows >= keepRows) break;
        const visible = ln.replace(/\u0001/g, '');
        const h2 = Math.max(1, Math.ceil(visible.length / wrapWidth));
        if (usedRows + h2 > keepRows && kept.length > 0) break;
        kept.push(ln);
        usedRows += h2;
      }
      view = { ...view, text: kept.join('\n') };
    }
    visibleTranscript.push(view);
  }
  // hiddenCount is for the "↑ N earlier messages" hint at the top —
  // count whole items that fall entirely above the window.
  let hiddenCount = 0;
  let cur = 0;
  for (const it of transcript) {
    const h = rowsForItem(it);
    if (cur + h <= startRow) hiddenCount += 1;
    cur += h;
  }
  const newerHidden = Math.max(0, offset);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Header
        agent={activeAgent}
        model={model}
        modelProvider={activeProviderKind}
        mode={mode}
        thinking={thinking}
        usage={usage}
        streaming={streaming}
        contextWindow={contextWindowFor(model, modelCatalog)}
        sessionId={sessionId}
        phase={activeTask?.phase ?? 'idle'}
      />
      {transcript.length === 0 && overlay.kind !== 'setup' && <Splash defaultModel={model} />}
      <Box flexDirection="column" flexGrow={1}>
        {hiddenCount > 0 && (
          <Text color="gray" dimColor>
            ↑ {hiddenCount} earlier message{hiddenCount === 1 ? '' : 's'} (PgUp to scroll)
          </Text>
        )}
        {visibleTranscript.map((item) => (
          <TranscriptRow key={item.key} item={item} />
        ))}
        {newerHidden > 0 && (
          <Text color="gray" dimColor>
            ↓ {newerHidden} more line{newerHidden === 1 ? '' : 's'} below (PgDn / End)
          </Text>
        )}
      </Box>
      {overlay.kind === 'agent-picker' && (
        <OverlayBox title="Switch agent (framework specialists are routed automatically)">
          <SelectInput
            items={switchableAgents.map((a) => ({
              key: a.name,
              label: `${a.role}${a.personaAlias ? ` — ${a.personaAlias}` : ''}${
                a.name === 'atlas' ? ' (orchestrator)' : ''
              }`,
              value: a.name
            }))}
            onSelect={onPickAgent}
          />
        </OverlayBox>
      )}
      {overlay.kind === 'model-picker' && (
        <OverlayBox
          title={
            overlay.purpose === 'compact'
              ? 'Pick summarizer model for /compact (↑/↓, ↵ select)'
              : 'Switch model (↑/↓ to navigate, ↵ select)'
          }
        >
          {(() => {
            const catalog = modelCatalog ?? [];
            const items: PickerEntry[] = [];

            const byProvider = new Map<string, typeof catalog>();
            for (const m of catalog) {
              const list = byProvider.get(m.provider) ?? [];
              byProvider.set(m.provider, [...list, m]);
            }

            const groupOrder: readonly ('anthropic' | 'openai-codex' | 'openrouter')[] = [
              'anthropic',
              'openai-codex',
              'openrouter'
            ];
            const groupLabel = (k: string): string => {
              if (k === 'anthropic') return '── Anthropic ──';
              if (k === 'openai-codex') return '── OpenAI (ChatGPT / Codex) ──';
              if (k === 'openrouter') return '── OpenRouter ──';
              return `── ${k} ──`;
            };
            // Seed list to inject into the OpenRouter group when the live
            // catalog is missing entries (cache stale / network blocked /
            // first launch). Includes the curated wide defaults the user
            // wants always visible (kimi-2.6, deepseek-v4, opus-4.7…) plus
            // anything that came from `availableModels`/`fallbackModels`.
            const orSeed = [
              ...(props.availableModels ?? []),
              ...(props.fallbackModels ?? []),
              props.defaultModel
            ].filter((id) => typeof id === 'string' && id.includes('/'));

            const seenValues = new Set<string>();

            for (const grp of groupOrder) {
              if (!props.providers?.[grp]) continue;
              const catalogList = byProvider.get(grp) ?? [];
              // Custom (saved) ids only make sense under OpenRouter — they
              // come exclusively from the +Add custom model id… flow which
              // is OR-only (Anthropic/Codex catalogs are fixed by the
              // provider). Dedup against the catalog & seed below.
              const customsHere = grp === 'openrouter' ? extraModels : [];
              const seedHere = grp === 'openrouter' ? orSeed : [];
              if (catalogList.length === 0 && customsHere.length === 0 && seedHere.length === 0) {
                continue;
              }
              items.push({ kind: 'header', key: `__hdr_${grp}`, label: groupLabel(grp) });
              const groupSeen = new Set<string>();
              const addEntry = (id: string, label: string, pinned = false): void => {
                if (groupSeen.has(id)) return;
                groupSeen.add(id);
                if (seenValues.has(`${grp}:${id}`)) return;
                seenValues.add(`${grp}:${id}`);
                items.push({
                  kind: 'item',
                  key: `${grp}:${id}`,
                  label,
                  value: `${grp}:${id}`,
                  ...(pinned ? { pinned: true } : {})
                });
              };

              // Within OpenRouter: a "★ Popular" sub-header with the
              // curated pins first, then the rest of the catalog. We
              // match pins against catalog ids by *pattern* (rather than
              // a hard-coded id string) so when the live OR catalog uses
              // a slightly different slug — e.g. `moonshotai/kimi-k2.6`
              // instead of `moonshotai/kimi-2.6` — the pin still resolves
              // to the real model and dedups properly. Anthropic / Codex
              // have no pins (their catalogs are short and curated).
              if (grp === 'openrouter') {
                const POPULAR_PATTERNS: readonly {
                  readonly desc: string;
                  readonly fallback: string;
                  readonly match: (id: string) => boolean;
                }[] = [
                  {
                    desc: 'Claude Opus 4.7',
                    fallback: 'anthropic/claude-opus-4.7',
                    match: (id) =>
                      /^anthropic\/claude-opus-4[.\-]?7$/i.test(id)
                  },
                  {
                    desc: 'Claude Opus 4.6',
                    fallback: 'anthropic/claude-opus-4.6',
                    match: (id) =>
                      /^anthropic\/claude-opus-4[.\-]?6$/i.test(id)
                  },
                  {
                    desc: 'Claude Sonnet 4.6',
                    fallback: 'anthropic/claude-sonnet-4.6',
                    match: (id) =>
                      /^anthropic\/claude-sonnet-4[.\-]?6$/i.test(id)
                  },
                  {
                    desc: 'Claude Sonnet 4.5',
                    fallback: 'anthropic/claude-sonnet-4.5',
                    match: (id) =>
                      /^anthropic\/claude-sonnet-4[.\-]?5$/i.test(id)
                  },
                  {
                    desc: 'DeepSeek V4',
                    fallback: 'deepseek/deepseek-v4',
                    match: (id) =>
                      /^deepseek\/deepseek-v?4$/i.test(id) ||
                      /^deepseek\/deepseek-v?4-(chat|base|pro)$/i.test(id)
                  },
                  {
                    desc: 'DeepSeek V4 Flash',
                    fallback: 'deepseek/deepseek-v4-flash',
                    match: (id) => /^deepseek\/deepseek-v?4[-.]flash/i.test(id)
                  },
                  {
                    desc: 'Kimi 2.6',
                    fallback: 'moonshotai/kimi-2.6',
                    match: (id) => /^moonshotai\/kimi-?(k)?2[.\-]?6/i.test(id)
                  },
                  {
                    desc: 'GPT-5.5',
                    fallback: 'openai/gpt-5.5',
                    match: (id) => /^openai\/gpt-5[.\-]?5$/i.test(id)
                  },
                  {
                    desc: 'GPT-5',
                    fallback: 'openai/gpt-5',
                    match: (id) => /^openai\/gpt-5$/i.test(id)
                  },
                  {
                    desc: 'Gemini 2.5 Pro',
                    fallback: 'google/gemini-2.5-pro',
                    match: (id) => /^google\/gemini-2\.5-pro$/i.test(id)
                  }
                ];
                const popularHere: { id: string; label: string }[] = [];
                const usedIds = new Set<string>();
                for (const pat of POPULAR_PATTERNS) {
                  const hit = catalogList.find(
                    (m) => pat.match(m.id) && !usedIds.has(m.id)
                  );
                  if (hit) {
                    usedIds.add(hit.id);
                    const label = hit.label !== hit.id ? `${hit.id} — ${hit.label}` : hit.id;
                    popularHere.push({ id: hit.id, label });
                  } else if (
                    // Only add fallback when the pin id isn't going to
                    // collide with a catalog entry (would create the
                    // exact dup the user reported). If the fallback
                    // string itself appears in the catalog, the loop
                    // above would have matched it already.
                    !catalogList.some((m) => m.id === pat.fallback)
                  ) {
                    popularHere.push({ id: pat.fallback, label: pat.fallback });
                  }
                }
                if (popularHere.length > 0) {
                  items.push({
                    kind: 'header',
                    key: '__hdr_or_popular',
                    label: '   ★ Popular'
                  });
                  for (const p of popularHere) addEntry(p.id, p.label, true);
                }
              }

              // Order within OR: pinned popular first (above), then
              // every remaining model — catalog ∪ seed defaults ∪ user
              // customs — sorted alphabetically by id so it's easy to
              // scan a long list. For Anthropic / Codex it's just the
              // catalog, also alphabetized.
              if (grp === 'openrouter') {
                const rest = new Map<string, string>();
                for (const m of catalogList) {
                  if (groupSeen.has(m.id)) continue;
                  rest.set(m.id, m.label !== m.id ? `${m.id} — ${m.label}` : m.id);
                }
                for (const id of seedHere) {
                  if (groupSeen.has(id) || rest.has(id)) continue;
                  rest.set(id, id);
                }
                for (const id of customsHere) {
                  if (groupSeen.has(id) || rest.has(id)) continue;
                  rest.set(id, id);
                }
                const sorted = [...rest.entries()].sort(([a], [b]) => a.localeCompare(b));
                for (const [id, lbl] of sorted) addEntry(id, lbl);
              } else {
                const sorted = [...catalogList].sort((a, b) => a.id.localeCompare(b.id));
                for (const m of sorted) {
                  const lbl = m.label !== m.id ? `${m.id} — ${m.label}` : m.id;
                  addEntry(m.id, lbl);
                }
              }
            }

            // Truly nothing — no providers connected or seed list empty.
            if (items.length === 0) {
              items.push({ kind: 'header', key: '__hdr_seed', label: '── Available models ──' });
              items.push({
                kind: 'item',
                key: `s:${props.defaultModel}`,
                label: props.defaultModel,
                value: props.defaultModel
              });
            }

            items.push({
              kind: 'item',
              key: '__custom__',
              label: '+ Add custom model id…',
              value: '__custom__'
            });
            const limit = Math.max(6, Math.min(items.length, rows - overlayReserve - 4));
            return <GroupedPicker items={items} limit={limit} onSelect={onPickModel} />;
          })()}
        </OverlayBox>
      )}
      {overlay.kind === 'model-freeform' && (
        <OverlayBox title="Enter model id (e.g. anthropic/claude-opus-4.7)">
          <TextInput value={input} onChange={setInput} onSubmit={onCustomModelSubmit} />
        </OverlayBox>
      )}
      {overlay.kind === 'option-picker' && (
        <OverlayBox title={`Atlas asks: ${overlay.request.prompt}`}>
          <SelectInput
            items={[
              ...overlay.request.options.slice(0, 3).map((o, i) => ({
                key: `o${i}`,
                label: o.label,
                value: o.value
              })),
              ...(overlay.request.allowFreeform
                ? [{ key: 'free', label: 'Type your own…', value: '__freeform__' }]
                : [])
            ]}
            onSelect={onPickOption}
          />
        </OverlayBox>
      )}
      {overlay.kind === 'option-freeform' && (
        <OverlayBox title={overlay.request.prompt}>
          <TextInput value={input} onChange={setInput} onSubmit={onFreeformSubmit} />
        </OverlayBox>
      )}
      {overlay.kind === 'autopilot-consent' && (
        <Box flexDirection="column" borderStyle="double" borderColor="red" paddingX={1} marginY={1}>
          <Text color="red" bold>
            ⚠  Enable autopilot mode?
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              Autopilot lets Atlas execute <Text bold>any tool</Text> — reading and writing files,
              running terminal commands, and calling external services — <Text bold>without asking</Text> for
              your approval each time.
            </Text>
            <Box marginTop={1}>
              <Text color="gray">
                Recommended only when you trust the active agent and have version control. You can leave
                autopilot at any time with Ctrl-P or `/mode build`.
              </Text>
            </Box>
          </Box>
          <Box marginTop={1}>
            <SelectInput
              items={[
                { key: 'no', label: 'No — stay in current mode', value: 'no' },
                { key: 'yes', label: 'Yes — enable autopilot for this session', value: 'yes' }
              ]}
              onSelect={onAutopilotConsent}
            />
          </Box>
        </Box>
      )}
      {overlay.kind === 'session-picker' && (
        <OverlayBox title="Resume a session">
          <SelectInput
            items={overlay.entries.map((e) => ({
              key: e.id,
              label: `${e.id}    ${new Date(e.updatedAt).toLocaleString()}`,
              value: e.id
            }))}
            onSelect={(item: { value: string }) => {
              if (!props.sessionStore) {
                closeOverlay();
                return;
              }
              void (async () => {
                const r = await props.sessionStore!.load(item.value);
                closeOverlay();
                if (!r.ok) {
                  pushItem('error', `failed to load session ${item.value}: ${r.error.message}`);
                  return;
                }
                sessionRef.current = r.value;
                messagesRef.current = [...r.value.messages];
                setSessionId(r.value.id);
                hydrateTranscriptFromMessages(
                  r.value.messages,
                  r.value.agent ?? activeAgent.name
                );
                pushItem(
                  'system',
                  `Resumed session ${r.value.id} (${r.value.messages.length} messages).`
                );
              })();
            }}
          />
          <Box marginTop={1}>
            <Text color="gray">Showing the {overlay.entries.length} most recent sessions. Esc to cancel.</Text>
          </Box>
        </OverlayBox>
      )}
      {overlay.kind === 'learn-confirm' && (
        <OverlayBox title="Atlas wants to save a learned skill">
          {overlay.stage === 'reflecting' && (
            <Box flexDirection="column">
              <Text color="cyan">Reflecting on the last turn…</Text>
              <Text color="gray">Trigger: {overlay.reason}</Text>
              <Box marginTop={1}>
                <Text color="gray">Esc to cancel.</Text>
              </Box>
            </Box>
          )}
          {overlay.stage === 'review' && overlay.error && !overlay.draft && (
            <Box flexDirection="column">
              <Text color="red">Reflection failed: {overlay.error}</Text>
              <Box marginTop={1}>
                <Text color="gray">Esc to dismiss.</Text>
              </Box>
            </Box>
          )}
          {overlay.stage === 'review' && overlay.draft && (
            <Box flexDirection="column">
              <Box>
                <Text color="gray">Name: </Text>
                <Text color="cyan" bold>{overlay.draft.name}</Text>
              </Box>
              <Box>
                <Text color="gray">What it does: </Text>
                <Text>{overlay.draft.description}</Text>
              </Box>
              <Box>
                <Text color="gray">Why created: </Text>
                <Text color="yellow">{overlay.reason}</Text>
              </Box>
              <Box>
                <Text color="gray">Triggers: </Text>
                <Text>{overlay.draft.triggers.join(', ') || '(none)'}</Text>
              </Box>
              <Box marginTop={1} flexDirection="column">
                <Text color="gray">Body preview:</Text>
                <Text>
                  {overlay.draft.body.split('\n').slice(0, 12).join('\n')}
                  {overlay.draft.body.split('\n').length > 12 ? '\n…' : ''}
                </Text>
              </Box>
              {overlay.error && (
                <Box marginTop={1}>
                  <Text color="red">Save failed: {overlay.error}</Text>
                </Box>
              )}
              <Box marginTop={1}>
                <SelectInput
                  items={[
                    { key: 'save', label: 'Save (only framework agents will see it)', value: 'save' },
                    { key: 'discard', label: 'Discard', value: 'discard' }
                  ]}
                  onSelect={(item: { value: string }) => {
                    if (item.value === 'save' && overlay.draft) {
                      void saveLearnedSkillDraft(overlay.draft);
                    } else {
                      setOverlay({ kind: 'none' });
                    }
                  }}
                />
              </Box>
              <Box marginTop={1}>
                <Text color="gray">Esc to discard. Learned skills live in ~/.atlas/skills/ and are not /-invokable.</Text>
              </Box>
            </Box>
          )}
          {overlay.stage === 'saving' && (
            <Box>
              <Text color="cyan">Saving skill…</Text>
            </Box>
          )}
        </OverlayBox>
      )}
      {overlay.kind === 'onboard' && overlay.stage === 'loading' && (
        <OverlayBox title="/onboard preflight">
          <Text color="cyan">Scanning repository and estimating token/cost envelope...</Text>
          <Box marginTop={1}>
            <Text color="gray">Esc to cancel</Text>
          </Box>
        </OverlayBox>
      )}
      {overlay.kind === 'onboard' && overlay.stage === 'mode' && (
        <OverlayBox title="Onboard existing repository">
          <Box flexDirection="column" marginBottom={1}>
            <Text>{onboardCostLabel(overlay.draft)}</Text>
            <Text color="gray">
              Choose one mode. Full uses one model by default; cost-reduction lets you pick cheap/fallback/per-stage.
            </Text>
          </Box>
          <SelectInput
            items={[
              { key: 'full', label: 'Full onboard (default model for all stages)', value: 'full' },
              { key: 'cost', label: 'Cost reduction mode (choose model strategy)', value: 'cost-reduction' },
              { key: 'map', label: 'Map only (write docs/repo-map.md, no long-form generation)', value: 'map-only' }
            ]}
            onSelect={onOnboardModePick}
          />
        </OverlayBox>
      )}
      {overlay.kind === 'onboard' && overlay.stage === 'strategy' && (
        <OverlayBox title="Onboard cost-reduction strategy">
          <SelectInput
            items={[
              { key: 'same', label: 'Single cheap model for all stages', value: 'same-model' },
              { key: 'fallback', label: 'Cheap model + strong fallback', value: 'cheap-fallback' },
              { key: 'manual', label: 'Manual per-stage model selection', value: 'manual' }
            ]}
            onSelect={onOnboardStrategyPick}
          />
        </OverlayBox>
      )}
      {overlay.kind === 'onboard' && overlay.stage === 'pick-model' && (
        <OverlayBox
          title={`Pick model for ${
            overlay.target === 'same'
              ? 'all stages'
              : overlay.target === 'cheap'
                ? 'cheap pass'
                : overlay.target === 'fallback'
                  ? 'strong fallback'
                  : `${overlay.target} stage`
          }`}
        >
          <SelectInput
            items={availableModelIds.map((id) => ({ key: id, label: id, value: id }))}
            onSelect={onOnboardPickModel}
          />
        </OverlayBox>
      )}
      {overlay.kind === 'onboard' && overlay.stage === 'confirm' && (
        <OverlayBox title="Confirm onboard plan">
          <Box flexDirection="column" marginBottom={1}>
            <Text>{onboardCostLabel(overlay.draft)}</Text>
            <Text>mode: {overlay.draft.mode}</Text>
            <Text>strategy: {overlay.draft.strategy}</Text>
            {overlay.draft.strategy === 'same-model' && <Text>model: {overlay.draft.sameModel ?? model}</Text>}
            {overlay.draft.strategy === 'cheap-fallback' && (
              <Text>
                cheap: {overlay.draft.cheapModel ?? model} · fallback: {overlay.draft.fallbackModel ?? model}
              </Text>
            )}
            {overlay.draft.strategy === 'manual' && (
              <Text>
                map: {overlay.draft.stageModels?.map ?? model} · architecture: {overlay.draft.stageModels?.architecture ?? model} · onboarding: {overlay.draft.stageModels?.onboarding ?? model}
              </Text>
            )}
          </Box>
          <SelectInput
            items={[
              { key: 'start', label: 'Start onboard', value: 'start' },
              { key: 'back', label: 'Back', value: 'back' },
              { key: 'cancel', label: 'Cancel', value: 'cancel' }
            ]}
            onSelect={(item) => {
              if (item.value === 'start') {
                void executeOnboard();
                return;
              }
              if (item.value === 'back') {
                setOverlay({ kind: 'onboard', stage: 'mode', draft: overlay.draft });
                return;
              }
              closeOverlay();
            }}
          />
        </OverlayBox>
      )}
      {overlay.kind === 'onboard' && overlay.stage === 'running' && (
        <OverlayBox title="Running /onboard">
          <Text color="cyan">{overlay.status}</Text>
          <Box marginTop={1}>
            <Text color="gray">Please wait...</Text>
          </Box>
        </OverlayBox>
      )}
      {overlay.kind === 'mcp-add' && overlay.stage === 'pick' && (
        <OverlayBox title="Add MCP server (pick from suggested catalog)">
          <SelectInput
            items={(() => {
              const installed = new Set(
                (props.config?.mcp.servers ?? []).map((cs) => cs.name)
              );
              const rows = MCP_SUGGESTIONS
                .filter((s) => !installed.has(s.name))
                .map((s) => {
                  const runtime = s.transport === 'http' ? 'http' : (s.prerequisite.label ?? s.prerequisite.bin);
                  return {
                    key: s.id,
                    label: `${s.name.padEnd(14)} [${s.pricing.padEnd(8)}] [${runtime}]  ${s.summary}`,
                    value: s.id
                  };
                });
              rows.push({
                key: '__custom__',
                label: 'custom…     [byo]      [·]      Add a server not in this list (manual or AI-assisted)',
                value: '__custom__'
              });
              return rows;
            })()}
            onSelect={onMcpPick}
          />
          <Box marginTop={1} flexDirection="column">
            <Text color="gray">
              Tags: [free] local • [byo] free tool, you supply credentials • [freemium] free tier + paid • [paid] costs money.
            </Text>
            <Text color="gray">
              Runtime [npx]/[binary]/[http]: how the server runs. We auto-check the binary on PATH and offer install options.
            </Text>
          </Box>
        </OverlayBox>
      )}
      {overlay.kind === 'mcp-add' && overlay.stage === 'prereq' && (() => {
        const sug = findSuggestion(overlay.suggestionId);
        if (!sug || sug.transport !== 'stdio') return null;
        const prereq = sug.prerequisite;
        const ai = prereq.autoInstall;
        const items = [
          ...(ai && !overlay.installing
            ? [{ key: 'install', label: `Install for me — ${ai.description}`, value: 'install' }]
            : []),
          { key: 'recheck', label: 'I\u2019ve installed it \u2014 re-check PATH', value: 'recheck' },
          { key: 'docs', label: `Open install docs (${prereq.docsUrl})`, value: 'docs' },
          { key: 'skip', label: 'Skip / cancel', value: 'skip' }
        ];
        return (
          <OverlayBox title={`${sug.name} needs '${prereq.bin}' \u2014 not found on PATH`}>
            <Box flexDirection="column" marginBottom={1}>
              <Text color="gray">
                {ai
                  ? `${ai.description} You can have Atlas run the installer, do it yourself, or skip.`
                  : `Atlas can\u2019t auto-install '${prereq.bin}' safely. Install it via the docs link, then re-check.`}
              </Text>
              {overlay.statusLine ? (
                <Text color={overlay.statusLine.startsWith('error') ? 'red' : 'green'}>
                  {overlay.statusLine}
                </Text>
              ) : null}
              {overlay.installing ? <Text color="yellow">{'installing\u2026 (Esc to cancel)'}</Text> : null}
            </Box>
            {!overlay.installing ? (
              <SelectInput items={items} onSelect={onMcpPrereqAction} />
            ) : null}
          </OverlayBox>
        );
      })()}
      {overlay.kind === 'mcp-add' && overlay.stage === 'auth' && (() => {
        const sug = findSuggestion(overlay.suggestionId);
        if (!sug || sug.transport !== 'stdio') return null;
        const methods = sug.authMethods ?? [];
        const items = [
          ...(methods.includes('oauth-gh')
            ? [{ key: 'oauth-gh', label: 'OAuth via `gh` CLI \u2014 pull token from your existing gh login', value: 'oauth-gh' }]
            : []),
          ...(methods.includes('oauth-browser') && (sug.id === 'github' || sug.oauthBrowserUrl)
            ? [{
                key: 'oauth-browser',
                label:
                  sug.id === 'github'
                    ? 'OAuth via browser \u2014 sign in & click Authorize, no token to paste'
                    : 'OAuth via browser \u2014 open the token-creation page, then paste the token back',
                value: 'oauth-browser'
              }]
            : []),
          ...(methods.includes('pat')
            ? [{ key: 'pat', label: 'Personal Access Token \u2014 I already have one, let me paste it', value: 'pat' }]
            : []),
          { key: 'docs', label: 'I don\u2019t have `gh` yet \u2014 open install docs', value: 'docs' },
          { key: 'cancel', label: 'Cancel', value: 'cancel' }
        ];
        return (
          <OverlayBox title={`How would you like to authenticate ${sug.name}?`}>
            <Box flexDirection="column" marginBottom={1}>
              <Text color="gray">
                gh CLI = no paste, scopes follow your `gh auth login`. Browser = opens GitHub
                so you can sign in and click Authorize \u2014 atlas captures the token, no PAT
                to copy. PAT = you already have one ready.
              </Text>
              {overlay.statusLine ? (
                <Text color={overlay.statusLine.startsWith('error') ? 'red' : 'green'}>
                  {overlay.statusLine}
                </Text>
              ) : null}
              {overlay.probing ? <Text color="yellow">{'running `gh auth token`\u2026'}</Text> : null}
            </Box>
            {!overlay.probing ? <SelectInput items={items} onSelect={onMcpAuthSelect} /> : null}
          </OverlayBox>
        );
      })()}
      {overlay.kind === 'mcp-add' && overlay.stage === 'oauth-device' && (() => {
        const sug = findSuggestion(overlay.suggestionId);
        if (!sug) return null;
        const statusColor =
          overlay.statusKind === 'error'
            ? 'red'
            : overlay.statusKind === 'ok'
              ? 'green'
              : 'yellow';
        return (
          <OverlayBox title={`Sign in to GitHub \u2014 OAuth device flow`}>
            <Box flexDirection="column" marginBottom={1}>
              {overlay.userCode ? (
                <>
                  <Text color="gray">{'1. Browser opened to:'}</Text>
                  <Text color="cyan">{`   ${overlay.verificationUri ?? 'https://github.com/login/device'}`}</Text>
                  <Text color="gray">{'2. Enter this code, then click Authorize:'}</Text>
                  <Box marginTop={1} marginBottom={1} marginLeft={3}>
                    <Text color="green" bold>
                      {overlay.userCode}
                    </Text>
                  </Box>
                </>
              ) : (
                <Text color="gray">{'requesting device code from GitHub\u2026'}</Text>
              )}
              {overlay.statusLine ? (
                <Text color={statusColor}>{overlay.statusLine}</Text>
              ) : null}
              <Text color="gray">{'Press Esc to cancel.'}</Text>
            </Box>
          </OverlayBox>
        );
      })()}
      {overlay.kind === 'mcp-add' && overlay.stage === 'env' && (() => {
        const sug = findSuggestion(overlay.suggestionId);
        const spec = sug?.env[overlay.envIndex];
        if (!sug || !spec) return null;
        // Friendly per-key prompts. We special-case the well-known
        // secret keys so the user sees a clear action ("Paste your
        // GitHub Personal Access Token") instead of the dry env-var
        // description we use as a fallback.
        const friendly: Record<string, { title: string; helper: string }> = {
          GITHUB_PERSONAL_ACCESS_TOKEN: {
            title: 'Paste your GitHub Personal Access Token',
            helper:
              'Create one at https://github.com/settings/tokens (classic or fine-grained). Pick the scopes you want Atlas to use — at minimum `repo` for private repos, or `public_repo` for public-only.'
          },
          HIGGSFIELD_API_KEY: {
            title: 'Paste your Higgsfield API key',
            helper: 'Grab it from https://higgsfield.ai/mcp \u2192 your account.'
          },
          FIGMA_API_TOKEN: {
            title: 'Paste your Figma personal access token',
            helper:
              'Create one in Figma \u2192 Settings \u2192 Account \u2192 Personal access tokens.'
          }
        };
        const f = friendly[spec.key];
        const title = f
          ? `${f.title}${spec.required ? '' : ' (optional)'}`
          : `${sug.name} \u2192 ${spec.key}${spec.required ? ' (required)' : ' (optional)'}`;
        const helper = f?.helper ?? spec.description;
        return (
          <OverlayBox title={title}>
            <Box flexDirection="column" marginBottom={1}>
              <Text color="gray">{helper}</Text>
              <Text color="gray">{'Press \u21b5 to save, Esc to cancel.'}</Text>
            </Box>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={onMcpEnvSubmit}
              placeholder={spec.placeholder ?? ''}
              mask={spec.required ? '*' : undefined}
            />
          </OverlayBox>
        );
      })()}
      {overlay.kind === 'mcp-add' && overlay.stage === 'confirm' && (() => {
        const sug = findSuggestion(overlay.suggestionId);
        if (!sug) return null;
        return (
          <OverlayBox title={`Add MCP server '${sug.name}'?`}>
            <Box flexDirection="column" marginBottom={1}>
              {sug.transport === 'http' ? (
                <>
                  <Text>
                    <Text color="gray">url:     </Text>
                    <Text>{sug.url}</Text>
                  </Text>
                  <Text>
                    <Text color="gray">headers: </Text>
                    <Text>{Object.keys(sug.headerTemplate).join(', ')}</Text>
                  </Text>
                </>
              ) : (
                <Text>
                  <Text color="gray">command: </Text>
                  <Text>{[sug.command, ...sug.args].join(' ')}</Text>
                </Text>
              )}
              {Object.keys(overlay.collected).length > 0 ? (
                <Text>
                  <Text color="gray">secrets: </Text>
                  <Text>{Object.keys(overlay.collected).join(', ')}</Text>
                </Text>
              ) : null}
              <Text color="gray">docs:    {sug.docs}</Text>
            </Box>
            <SelectInput
              items={[
                { key: 'no', label: 'No — cancel', value: 'no' },
                { key: 'yes', label: 'Yes — save to ~/.atlas/config.yaml', value: 'yes' }
              ]}
              onSelect={onMcpConfirm}
            />
          </OverlayBox>
        );
      })()}
      {overlay.kind === 'mcp-restart-prompt' && (
        <OverlayBox title={`'${overlay.serverName}' added \u2014 restart required`}>
          <Box flexDirection="column" marginBottom={1}>
            <Text>
              <Text color="green">{'\u2713 saved'}</Text>
              <Text color="gray"> to {overlay.configPath}</Text>
            </Text>
            <Box marginTop={1}>
              <Text>
                MCP servers are spawned at startup, so atlas needs a restart to load
                <Text color="cyan" bold> {overlay.serverName} </Text>
                and pick up its tools.
              </Text>
            </Box>
          </Box>
          <SelectInput
            items={[
              { key: 'quit', label: 'Quit now (then re-run `atlas`)', value: 'quit' },
              { key: 'later', label: 'Later \u2014 keep chatting (tools won\u2019t be available yet)', value: 'later' }
            ]}
            onSelect={(item) => {
              if (item.value === 'quit') {
                pushItem('system', `Quitting so you can restart and load '${overlay.serverName}'.`);
                app.exit();
                return;
              }
              closeOverlay();
            }}
          />
        </OverlayBox>
      )}
      {overlay.kind === 'mcp-list' && (() => {
        const servers = props.config?.mcp?.servers ?? [];
        const running = props.mcpStatus?.running ?? [];
        const failed = props.mcpStatus?.failed ?? [];
        // Status mark + label tail per server. Use SetupMenuItem's
        // `\u0001` sentinel so the tail renders in green.
        const items = servers.map((s) => {
          const live = running.find((r) => r.name === s.name);
          const fail = failed.find((f) => f.name === s.name);
          const tail = !s.enabled
            ? '\u0001\u25cb disabled'
            : live
              ? `\u0001\u2022 connected (${live.toolCount} tool${live.toolCount === 1 ? '' : 's'})`
              : fail
                ? `\u0001\u2717 error`
                : '\u0001\u2026 pending';
          return {
            key: `srv:${s.name}`,
            label: `${s.name.padEnd(20)} ${tail}`,
            value: `srv:${s.name}`
          };
        });
        // Failed entries that aren't in the saved list (shouldn't normally
        // happen, but surface them anyway so they're not invisible).
        for (const f of failed) {
          if (!servers.some((s) => s.name === f.name)) {
            items.push({
              key: `srv:${f.name}`,
              label: `${f.name.padEnd(20)} \u0001\u2717 error`,
              value: `srv:${f.name}`
            });
          }
        }
        items.push(
          { key: 'add', label: '+ Add new server\u2026', value: '__add__' },
          { key: 'close', label: 'Close', value: '__close__' }
        );
        const title = `MCP servers (${servers.length} configured, ${running.length} running)`;
        return (
          <OverlayBox title={title}>
            {servers.length === 0 ? (
              <Box marginBottom={1}>
                <Text color="gray">
                  {'No MCP servers configured yet. Pick \u201c+ Add new server\u2026\u201d to install one from the catalog.'}
                </Text>
              </Box>
            ) : null}
            <SelectInput
              itemComponent={SetupMenuItem}
              items={items}
              onSelect={(item) => {
                if (item.value === '__close__') {
                  closeOverlay();
                  return;
                }
                if (item.value === '__add__') {
                  setOverlay({ kind: 'mcp-add', stage: 'pick' });
                  return;
                }
                const name = item.value.startsWith('srv:') ? item.value.slice(4) : item.value;
                setOverlay({ kind: 'mcp-manage', serverName: name });
              }}
            />
            {overlay.statusLine ? (
              <Box marginTop={1}>
                <Text color={overlay.statusLine.startsWith('error') ? 'red' : 'green'}>
                  {overlay.statusLine}
                </Text>
              </Box>
            ) : null}
            <Box marginTop={1}>
              <Text color="gray">{'\u25b2/\u25bc to navigate \u00b7 \u21b5 to open \u00b7 Esc to close'}</Text>
            </Box>
          </OverlayBox>
        );
      })()}
      {overlay.kind === 'mcp-manage' && (() => {
        const servers = props.config?.mcp?.servers ?? [];
        const running = props.mcpStatus?.running ?? [];
        const failed = props.mcpStatus?.failed ?? [];
        const cfg = servers.find((s) => s.name === overlay.serverName);
        const live = running.find((r) => r.name === overlay.serverName);
        const fail = failed.find((f) => f.name === overlay.serverName);
        const isBuiltin = builtinNames.has(overlay.serverName);
        const enabled = cfg?.enabled ?? false;
        const target = !cfg
          ? '(not configured)'
          : cfg.transport === 'http'
            ? `http \u2192 ${cfg.url ?? '?'}`
            : [cfg.command ?? '?', ...cfg.args].join(' ');
        const statusBits: React.JSX.Element[] = [];
        if (!cfg) {
          statusBits.push(
            <Text key="missing" color="red">{'\u2717 not configured'}</Text>
          );
        } else if (!enabled) {
          statusBits.push(<Text key="off" color="yellow">{'\u25cb disabled'}</Text>);
        } else if (live) {
          statusBits.push(
            <Text key="on" color="green">
              {`\u2022 connected (${live.toolCount} tool${live.toolCount === 1 ? '' : 's'})`}
            </Text>
          );
        } else if (fail) {
          statusBits.push(<Text key="err" color="red">{`\u2717 error: ${fail.error}`}</Text>);
        } else {
          statusBits.push(<Text key="pending" color="gray">{'\u2026 pending'}</Text>);
        }
        const items: { key: string; label: string; value: string }[] = [];
        if (cfg) {
          items.push(
            enabled
              ? { key: 'disable', label: 'Disable', value: 'disable' }
              : { key: 'enable', label: 'Enable', value: 'enable' }
          );
          if (!isBuiltin) {
            items.push({ key: 'remove', label: 'Remove\u2026', value: 'remove' });
          }
        }
        items.push({ key: 'back', label: 'Back to list', value: 'back' });
        items.push({ key: 'close', label: 'Close', value: 'close' });
        return (
          <OverlayBox title={`MCP server \u00b7 ${overlay.serverName}`}>
            <Box flexDirection="column" marginBottom={1}>
              <Text>
                <Text color="gray">status: </Text>
                {statusBits}
              </Text>
              <Text>
                <Text color="gray">runs:  </Text>
                <Text>{target}</Text>
              </Text>
              {isBuiltin ? (
                <Text color="gray">{'(built-in: cannot be removed, only disabled)'}</Text>
              ) : null}
            </Box>
            <SelectInput
              items={items}
              onSelect={(item) => {
                const name = overlay.serverName;
                if (item.value === 'back') {
                  setOverlay({ kind: 'mcp-list' });
                  return;
                }
                if (item.value === 'close') {
                  closeOverlay();
                  return;
                }
                if (item.value === 'enable' || item.value === 'disable') {
                  void (async (): Promise<void> => {
                    const status = await setMcpEnabled(name, item.value === 'enable');
                    setOverlay({ kind: 'mcp-list', statusLine: `'${name}': ${status}` });
                  })();
                  return;
                }
                if (item.value === 'remove') {
                  void (async (): Promise<void> => {
                    const status = await removeMcp(name);
                    setOverlay({ kind: 'mcp-list', statusLine: `'${name}': ${status}` });
                  })();
                  return;
                }
              }}
            />
            {overlay.statusLine ? (
              <Box marginTop={1}>
                <Text color={overlay.statusLine.startsWith('error') ? 'red' : 'green'}>
                  {overlay.statusLine}
                </Text>
              </Box>
            ) : null}
          </OverlayBox>
        );
      })()}
      {overlay.kind === 'tools-list' && (() => {
        const dot = (s: ResolvedToolStatus['status']['state']): { mark: string; color: string } => {
          switch (s) {
            case 'connected': return { mark: '\u25cf', color: 'green' };
            case 'degraded':  return { mark: '\u25cf', color: 'yellow' };
            case 'disconnected': return { mark: '\u25cf', color: 'red' };
            case 'disabled':  return { mark: '\u25cb', color: 'gray' };
            default:          return { mark: '\u25cf', color: 'gray' };
          }
        };
        // Group entries by `entry.group` for legible display.
        const groupOrder: readonly CatalogEntry['group'][] = ['core', 'workflow', 'web', 'meta'];
        const items: { key: string; label: string; value: string }[] = [];
        for (const g of groupOrder) {
          const subset = overlay.entries.filter((e) => e.entry.group === g);
          if (subset.length === 0) continue;
          for (const r of subset) {
            const d = dot(r.status.state);
            // SetupMenuItem renders the segment after `\u0001` in green;
            // we encode the dot+detail manually so the color matches the
            // status state. (We split on \u0001 so the label part is the
            // padded name + kind, and the tail is the colored dot+detail.)
            const left = `${r.entry.title.padEnd(22)}`;
            const tail = `${d.mark} ${r.status.detail}`;
            // Pre-color with ink-friendly markers via SetupMenuItem? We
            // can't recolor per-item easily — keep it readable via plain
            // text and rely on the manage screen for nuance.
            items.push({
              key: `t:${r.entry.name}`,
              label: `${left} \u0001${tail}`,
              value: `t:${r.entry.name}`
            });
          }
        }
        items.push({ key: 'close', label: 'Close', value: '__close__' });
        const connected = overlay.entries.filter((e) => e.status.state === 'connected').length;
        const total = overlay.entries.length;
        const title = `Tools (${connected}/${total} connected)`;
        return (
          <OverlayBox title={title}>
            <Box flexDirection="column" marginBottom={1}>
              <Text color="gray">
                {'\u25cf green = connected   \u25cf yellow = degraded   \u25cf red = unavailable   \u25cb disabled'}
              </Text>
            </Box>
            <SelectInput
              itemComponent={SetupMenuItem}
              items={items}
              onSelect={(item) => {
                if (item.value === '__close__') {
                  closeOverlay();
                  return;
                }
                const name = item.value.startsWith('t:') ? item.value.slice(2) : item.value;
                setOverlay({
                  kind: 'tools-manage',
                  entries: overlay.entries,
                  toolName: name
                });
              }}
            />
            {overlay.statusLine ? (
              <Box marginTop={1}>
                <Text color={overlay.statusLine.startsWith('error') ? 'red' : 'green'}>
                  {overlay.statusLine}
                </Text>
              </Box>
            ) : null}
            <Box marginTop={1}>
              <Text color="gray">{'\u25b2/\u25bc to navigate \u00b7 \u21b5 to open \u00b7 Esc to close'}</Text>
            </Box>
          </OverlayBox>
        );
      })()}
      {overlay.kind === 'tools-manage' && (() => {
        const r = overlay.entries.find((e) => e.entry.name === overlay.toolName);
        if (!r) {
          return (
            <OverlayBox title={`Tool · ${overlay.toolName}`}>
              <Text color="red">{`Unknown tool: ${overlay.toolName}`}</Text>
            </OverlayBox>
          );
        }
        const refreshAndBackToList = async (statusLine?: string): Promise<void> => {
          const registered = new Set(props.tools.list().map((t) => t.name));
          const entries = await resolveCatalogStatus(registered);
          setOverlay({ kind: 'tools-list', entries, ...(statusLine ? { statusLine } : {}) });
        };
        const runAction = (actionId: 'enable' | 'disable' | 'install' | 'start' | 'stop' | 'restart' | 'remove'): void => {
          void (async (): Promise<void> => {
            // Mark busy so the user sees a "working…" state for slow
            // managed actions (image pulls, container starts, browser
            // installs all stream a few lines).
            setOverlay({ ...overlay, busy: true, statusLine: `${overlay.toolName}: ${actionId}…` });
            const result = await runToolAction(overlay.toolName, actionId, (line) => {
              // Live progress goes to the system transcript so the user
              // can read it without us hijacking the overlay body.
              pushItem('system', `${overlay.toolName}: ${line.trim()}`);
            });
            const tag = result.ok ? '' : 'error: ';
            await refreshAndBackToList(`${tag}${result.message}`);
          })();
        };

        // Build the action list. Essential tools never get `remove`.
        const actions: { key: string; label: string; value: string; warn?: string }[] = [];
        const isEnabled = !r.disabled;
        if (isEnabled) {
          actions.push({
            key: 'disable',
            label: 'Disable',
            value: 'disable',
            ...(r.entry.essential
              ? { warn: 'This is an essential tool. Disabling it will likely break agent workflows that rely on it. Continue?' }
              : {})
          });
        } else {
          actions.push({ key: 'enable', label: 'Enable', value: 'enable' });
        }
        for (const a of r.entry.extraActions ?? []) {
          actions.push({
            key: a.id,
            label: a.label,
            value: a.id,
            ...(a.warning ? { warn: a.warning } : {})
          });
        }
        actions.push({ key: 'back', label: 'Back to list', value: '__back__' });
        actions.push({ key: 'close', label: 'Close', value: '__close__' });

        const stateColor =
          r.status.state === 'connected'
            ? 'green'
            : r.status.state === 'degraded'
              ? 'yellow'
              : r.status.state === 'disabled'
                ? 'gray'
                : r.status.state === 'disconnected'
                  ? 'red'
                  : 'gray';
        const dotMark = r.status.state === 'disabled' ? '\u25cb' : '\u25cf';

        if (overlay.confirm) {
          // Render a confirmation prompt instead of the action list.
          return (
            <OverlayBox title={`Confirm · ${r.entry.title}`}>
              <Box flexDirection="column" marginBottom={1}>
                <Text color="yellow">{overlay.confirm.warning}</Text>
              </Box>
              <SelectInput
                items={[
                  { key: 'yes', label: 'Yes, continue', value: 'yes' },
                  { key: 'no', label: 'Cancel', value: 'no' }
                ]}
                onSelect={(item) => {
                  if (item.value === 'no') {
                    setOverlay({ ...overlay, confirm: undefined as never });
                    return;
                  }
                  const actionId = overlay.confirm!.actionId;
                  setOverlay({ ...overlay, confirm: undefined as never });
                  runAction(actionId);
                }}
              />
            </OverlayBox>
          );
        }

        return (
          <OverlayBox title={`Tool · ${r.entry.title}`}>
            <Box flexDirection="column" marginBottom={1}>
              <Text>
                <Text color="gray">status:  </Text>
                <Text color={stateColor}>{`${dotMark} ${r.status.state}`}</Text>
                <Text color="gray">{` — ${r.status.detail}`}</Text>
              </Text>
              <Text>
                <Text color="gray">kind:    </Text>
                <Text>{`${r.entry.group}${r.entry.essential ? ' (essential)' : ''}`}</Text>
              </Text>
              <Text>
                <Text color="gray">about:   </Text>
                <Text>{r.entry.description}</Text>
              </Text>
              {r.entry.essential ? (
                <Text color="gray">{'(essential: cannot be removed; disable shows a warning)'}</Text>
              ) : null}
            </Box>
            <SelectInput
              items={actions.map(({ key, label, value }) => ({ key, label, value }))}
              onSelect={(item) => {
                if (item.value === '__back__') {
                  void refreshAndBackToList();
                  return;
                }
                if (item.value === '__close__') {
                  closeOverlay();
                  return;
                }
                const chosen = actions.find((a) => a.value === item.value);
                if (chosen?.warn) {
                  setOverlay({
                    ...overlay,
                    confirm: {
                      actionId: item.value as 'disable' | 'remove',
                      warning: chosen.warn
                    }
                  });
                  return;
                }
                runAction(item.value as 'enable' | 'disable' | 'install' | 'start' | 'stop' | 'restart' | 'remove');
              }}
            />
            {overlay.statusLine ? (
              <Box marginTop={1}>
                <Text color={overlay.statusLine.startsWith('error') ? 'red' : 'green'}>
                  {overlay.statusLine}
                </Text>
              </Box>
            ) : null}
            <Box marginTop={1}>
              <Text color="gray">
                {'Changes apply to disk now. Some actions only take effect on the next session restart.'}
              </Text>
            </Box>
          </OverlayBox>
        );
      })()}
      {overlay.kind === 'mcp-custom-menu' && (
        <OverlayBox title="Add a custom MCP server">
          <Box flexDirection="column" marginBottom={1}>
            <Text color="gray">
              {'Pick how you want to add a server that isn\u2019t in the curated list.'}
            </Text>
          </Box>
          <SelectInput
            items={[
              {
                key: 'ai',
                label: 'Ask AI \u2014 describe the MCP server, the model adds it for you',
                value: 'ai'
              },
              {
                key: 'manual',
                label: 'Manual \u2014 show me how to edit ~/.atlas/config.yaml',
                value: 'manual'
              },
              { key: 'back', label: 'Back to catalog', value: 'back' },
              { key: 'cancel', label: 'Cancel', value: 'cancel' }
            ]}
            onSelect={(item) => {
              if (item.value === 'ai') {
                setInput('');
                setOverlay({ kind: 'mcp-custom-prompt', draft: '' });
                return;
              }
              if (item.value === 'manual') {
                pushItem(
                  'system',
                  [
                    'Manual MCP server setup:',
                    '',
                    '  1. Open ~/.atlas/config.yaml',
                    '  2. Under `mcp.servers:` add an entry like:',
                    '',
                    '       - name: my-server',
                    '         transport: stdio   # or http',
                    '         command: npx       # for stdio',
                    '         args: [-y, "@vendor/mcp-server"]',
                    '         env: {}',
                    '         enabled: true',
                    '',
                    '     For HTTP servers use `url:` and optional `headers:` instead.',
                    '  3. Restart atlas to load the new server.'
                  ].join('\n')
                );
                closeOverlay();
                return;
              }
              if (item.value === 'back') {
                setOverlay({ kind: 'mcp-add', stage: 'pick' });
                return;
              }
              closeOverlay();
            }}
          />
        </OverlayBox>
      )}
      {overlay.kind === 'mcp-custom-prompt' && (
        <OverlayBox title="Ask AI to add an MCP server">
          <Box flexDirection="column" marginBottom={1}>
            <Text color="gray">
              {'Describe the MCP server you want to install (e.g. \u201cadd the linear mcp server\u201d).'}
            </Text>
            <Text color="gray">
              {'The helper is sandboxed: it can only fetch web pages and add ONE MCP entry.'}
            </Text>
          </Box>
          <Box>
            <Text color="cyan">{'\u203a '}</Text>
            <TextInput
              value={overlay.draft}
              onChange={(value) => setOverlay({ kind: 'mcp-custom-prompt', draft: value })}
              onSubmit={(value) => launchAiAddMcp(value)}
            />
          </Box>
          <Box marginTop={1}>
            <Text color="gray">{'\u21b5 to run \u00b7 Esc to cancel'}</Text>
          </Box>
        </OverlayBox>
      )}
      {overlay.kind === 'mcp-custom-running' && (() => {
        const ev = overlay;
        const lastTool = [...ev.events].reverse().find(
          (e) => e.type === 'tool_call' || e.type === 'tool_ok' || e.type === 'tool_error'
        );
        let statusLabel = 'thinking\u2026';
        let statusColor: 'cyan' | 'green' | 'red' | 'yellow' = 'cyan';
        if (ev.error) {
          statusLabel = `error: ${ev.error}`;
          statusColor = 'red';
        } else if (ev.finished) {
          statusLabel = 'finished';
          statusColor = 'green';
        } else if (lastTool?.type === 'tool_call') {
          statusLabel = `running tool: ${lastTool.name}\u2026`;
          statusColor = 'yellow';
        } else if (lastTool?.type === 'tool_ok') {
          statusLabel = `\u2713 ${lastTool.name}`;
          statusColor = 'green';
        } else if (lastTool?.type === 'tool_error') {
          statusLabel = `\u2717 ${lastTool.name}: ${lastTool.message}`;
          statusColor = 'red';
        }
        const toolLines = ev.events
          .filter((e) => e.type === 'tool_call' || e.type === 'tool_ok' || e.type === 'tool_error')
          .slice(-6)
          .map((e, i) => {
            if (e.type === 'tool_call') {
              // input arrives as a JSON-encoded string from the model.
              // Best-effort parse for a friendlier preview.
              let url = '';
              if (e.name === 'web_fetch' && typeof e.input === 'string') {
                try {
                  const parsed = JSON.parse(e.input) as { url?: unknown };
                  if (typeof parsed.url === 'string') url = ` ${parsed.url}`;
                } catch {
                  /* ignore */
                }
              }
              return (
                <Text key={`tc${i}`} color="gray">
                  {`  \u2192 ${e.name}${url}`}
                </Text>
              );
            }
            if (e.type === 'tool_ok') {
              return (
                <Text key={`to${i}`} color="green">
                  {`  \u2713 ${e.name}`}
                </Text>
              );
            }
            return (
              <Text key={`te${i}`} color="red">
                {`  \u2717 ${e.name}: ${e.message}`}
              </Text>
            );
          });
        const tail = ev.currentText.length > 240
          ? '\u2026' + ev.currentText.slice(-240)
          : ev.currentText;
        return (
          <OverlayBox title="AI helper \u00b7 adding MCP server">
            <Box flexDirection="column" marginBottom={1}>
              <Text>
                <Text color="gray">prompt: </Text>
                <Text>{ev.userPrompt}</Text>
              </Text>
              <Text>
                <Text color="gray">status: </Text>
                <Text color={statusColor}>{statusLabel}</Text>
              </Text>
            </Box>
            {toolLines.length > 0 ? (
              <Box flexDirection="column" marginBottom={1}>
                {toolLines}
              </Box>
            ) : null}
            {tail.length > 0 ? (
              <Box flexDirection="column" marginBottom={1}>
                <Text color="gray">model:</Text>
                <Text>{tail}</Text>
              </Box>
            ) : null}
            {ev.finished ? (
              <SelectInput
                items={[{ key: 'close', label: 'Close', value: 'close' }]}
                onSelect={() => closeOverlay()}
              />
            ) : (
              <Text color="gray">{'Esc to cancel'}</Text>
            )}
          </OverlayBox>
        );
      })()}
      {overlay.kind === 'setup' && overlay.stage === 'menu' && (
        <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1} marginY={1}>
          <Text color="cyan" bold>
            ⚙  Atlas setup
          </Text>
          <Box marginTop={1}>
            <Text color="gray">Choose what you want to configure. Press Esc to cancel.</Text>
          </Box>
          <Box marginTop={1}>
            <SelectInput
              itemComponent={SetupMenuItem}
              items={(() => {
                // Connection state must mean "I can actually use this
                // right now" — so it's derived from the providers map
                // (only populated when a runtime was successfully built
                // from working creds). For ChatGPT/Codex, the runtime
                // is not yet wired, so the badge will stay off until
                // that lands even though tokens are saved.
                const cfg = props.config;
                const hasOpenRouter = Boolean(props.providers?.openrouter);
                const hasAnthropicKey = Boolean(cfg?.providers.anthropic.apiKey);
                const hasClaudeCode =
                  Boolean(props.providers?.anthropic) && !hasAnthropicKey;
                const hasChatGpt = Boolean(props.providers?.['openai-codex']);
                const hasGithub = Boolean(cfg?.github?.token);
                const mcpCount = cfg?.mcp?.servers?.length ?? 0;
                // Sentinel \u0001 separates the action label from the
                // status note; SetupMenuItem renders the suffix green.
                const tag = (on: boolean, note = 'connected'): string =>
                  on ? `  \u0001● ${note}` : '';
                return [
                  {
                    key: 'openrouter',
                    label: `OpenRouter API key  (sk-or-...)${tag(hasOpenRouter)}`,
                    value: 'openrouter' as const
                  },
                  {
                    key: 'anthropic',
                    label: `Anthropic API key   (sk-ant-...)${tag(hasAnthropicKey)}`,
                    value: 'anthropic' as const
                  },
                  {
                    key: 'claude-code',
                    label: `Claude Code OAuth   (auto-detected)${tag(hasClaudeCode)}`,
                    value: 'claude-code' as const
                  },
                  {
                    key: 'chatgpt',
                    label: `Sign in with ChatGPT (browser, Codex)${tag(hasChatGpt)}`,
                    value: 'chatgpt' as const
                  },
                  {
                    key: 'github',
                    label: `GitHub token        (gh integration)${tag(hasGithub)}`,
                    value: 'github' as const
                  },
                  {
                    key: 'mcp',
                    label: `MCP server          (model context protocol)${tag(
                      mcpCount > 0,
                      `${mcpCount} configured`
                    )}`,
                    value: 'mcp' as const
                  }
                ];
              })()}
              onSelect={(item) => void onSetupMenuPick(item.value)}
            />
          </Box>
        </Box>
      )}
      {overlay.kind === 'setup' && overlay.stage === 'key' && (
        <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1} marginY={1}>
          <Text color="cyan" bold>
            ⚙  {overlay.target === 'anthropic' ? 'Anthropic API key' : 'OpenRouter API key'}
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              Paste your key below. It will be saved to{' '}
              <Text color="gray">~/.atlas/config.yaml</Text>.
            </Text>
            <Box marginTop={1}>
              <Text color="gray">
                {overlay.target === 'anthropic'
                  ? 'Get a key at https://console.anthropic.com/settings/keys'
                  : 'Get a key at https://openrouter.ai/keys'}
              </Text>
            </Box>
            <Box marginTop={1}>
              <Text color="gray" dimColor>
                Tip: paste multiple keys separated by commas — the first
                is primary, the rest are fallbacks rotated on 401/429.
              </Text>
            </Box>
            {props.setupError && (
              <Box marginTop={1}>
                <Text color="red">previous error: {props.setupError}</Text>
              </Box>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color="cyan">key › </Text>
            <TextInput
              value={overlay.draftKey}
              onChange={onSetupKeyChange}
              onSubmit={() => void onSetupSubmit()}
              mask="•"
              placeholder={overlay.target === 'anthropic' ? 'sk-ant-...' : 'sk-or-...'}
            />
          </Box>
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              ↵ save · Esc cancel
            </Text>
          </Box>
        </Box>
      )}
      {overlay.kind === 'setup' && overlay.stage === 'info' && (
        <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1} marginY={1}>
          <Text color="cyan" bold>
            ⚙  Atlas setup
          </Text>
          <Box marginTop={1} flexDirection="column">
            {(overlay.infoText ?? '').split('\n').map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              ↵ / Esc close
            </Text>
          </Box>
        </Box>
      )}
      {overlay.kind === 'none' && (
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          {streaming ? (
            <Box>
              <Text color="yellow">
                <Spinner type="dots" />
              </Text>
              <Text> streaming… (Esc to cancel)</Text>
            </Box>
          ) : (
            <Box width={cols - 4}>
              <Text color="cyan">› </Text>
              <TextInput value={input} onChange={setInput} onSubmit={handleInputSubmit} />
            </Box>
          )}
        </Box>
      )}
      {overlay.kind === 'none' && !streaming && (
        <SlashAutocomplete matches={matchSlashCommands(input)} activeIdx={slashIdx} />
      )}
      <StatusBar pendingExit={pendingExit} streaming={streaming} mode={mode} />
    </Box>
  );
};

const Header = ({
  agent,
  model,
  modelProvider,
  mode,
  thinking,
  usage,
  streaming,
  contextWindow,
  sessionId,
  phase
}: {
  agent: Agent;
  model: string;
  modelProvider: ProviderKindLabel;
  mode: Mode;
  thinking: ThinkingEffort;
  usage: {
    tokens: number;
    rounds: number;
    promptTokens?: number;
    completionTokens?: number;
  } | null;
  streaming: boolean;
  contextWindow: number;
  sessionId: string | null;
  phase: Phase;
}): React.JSX.Element => {
  const cost =
    usage && usage.promptTokens !== undefined && usage.completionTokens !== undefined
      ? estimateCost(model, usage.promptTokens, usage.completionTokens)
      : undefined;
  // "Used" = tokens of the most recent turn (input + output), since that's
  // what currently fills the model's context window. Falls back to 0 pre-turn.
  const used = usage?.tokens ?? 0;
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} marginBottom={0}>
      <Box flexGrow={1}>
        <Text color={colorForAgent(agent.name)} bold>
          {agent.role}
        </Text>
        {agent.personaAlias && <Text color="gray"> ({agent.personaAlias})</Text>}
        <Text color="gray"> · </Text>
        <Text color="white">{model}</Text>
        <Text color={providerColor(modelProvider)}> [{providerShortLabel(modelProvider)}]</Text>
        <Text color="gray"> · mode </Text>
        <Text color={modeColor(mode)} bold={mode === 'autopilot'}>
          {mode}
        </Text>
        {phase !== 'idle' && (
          <>
            <Text color="gray"> · phase </Text>
            <Text color={phaseColor(phase)} bold>
              {phase}
            </Text>
          </>
        )}
        <Text color="gray"> · think </Text>
        <Text color={thinking === 'off' ? 'gray' : 'magenta'}>{thinking}</Text>
        {streaming && (
          <>
            <Text color="gray"> · </Text>
            <Text color="yellow">streaming</Text>
          </>
        )}
        {sessionId && (
          <>
            <Text color="gray"> · session </Text>
            <Text color="cyan">{sessionId}</Text>
          </>
        )}
      </Box>
      <Box>
        <ContextBar used={used} total={contextWindow} />
        {usage && (
          <>
            <Text color="gray"> · </Text>
            <Text color="gray">{usage.rounds}rd</Text>
          </>
        )}
        {cost !== undefined && (
          <>
            <Text color="gray"> · </Text>
            <Text color="green">{formatCost(cost)}</Text>
          </>
        )}
      </Box>
    </Box>
  );
};

/** 10-cell unicode bar showing context-window fill. */
const ContextBar = ({ used, total }: { used: number; total: number }): React.JSX.Element => {
  const pct = total > 0 ? Math.min(1, used / total) : 0;
  const cells = 10;
  const filled = Math.round(pct * cells);
  const bar = '█'.repeat(filled) + '░'.repeat(cells - filled);
  const color = pct >= 0.9 ? 'red' : pct >= 0.7 ? 'yellow' : 'cyan';
  const usedShort = compactTokens(used);
  const totalShort = compactTokens(total);
  return (
    <>
      <Text color={color}>{bar}</Text>
      <Text color="gray"> {usedShort}/{totalShort}</Text>
    </>
  );
};

const compactTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
};

/**
 * Best-effort context window in tokens for a given model id. Uses the
 * live catalog when available, then falls back to known defaults so the
 * progress bar still renders for offline / custom ids.
 */
const contextWindowFor = (
  modelId: string,
  catalog: readonly import('@atlas/core').ModelInfo[] | undefined
): number => {
  const hit = catalog?.find((m) => m.id === modelId);
  if (hit?.contextWindow) return hit.contextWindow;
  const m = modelId.toLowerCase();
  if (/claude-(opus|sonnet|haiku)-4/.test(m)) return 200_000;
  if (/claude-3/.test(m)) return 200_000;
  if (/gpt-5|gpt-4\.1/.test(m)) return 1_000_000;
  if (/gpt-4o/.test(m)) return 128_000;
  if (/gemini-2\.5/.test(m)) return 1_000_000;
  if (/gemini-1\.5/.test(m)) return 1_000_000;
  return 128_000;
};

/** Provider tag rendered after the model id in the header. */
type ProviderKindLabel = 'openrouter' | 'anthropic' | 'openai-codex' | 'unknown';

/**
 * Resolve which provider exposes the given model id.
 *
 * Prefers the live catalog (so multi-key users get the correct tag for
 * `gpt-5` whether they signed in via OpenRouter or ChatGPT/Codex), then
 * falls back to id-shape heuristics for offline / custom ids.
 */
const providerKindFor = (
  modelId: string,
  catalog: readonly import('@atlas/core').ModelInfo[] | undefined
): ProviderKindLabel => {
  const hit = catalog?.find((m) => m.id === modelId);
  if (hit) return hit.provider;
  if (modelId.includes('/')) return 'openrouter';
  const m = modelId.toLowerCase();
  if (/^claude/.test(m)) return 'anthropic';
  if (/^(gpt-|codex-|o[1-9])/.test(m)) return 'openai-codex';
  return 'unknown';
};

const providerColor = (kind: ProviderKindLabel): string => {
  switch (kind) {
    case 'openrouter':
      return 'magenta';
    case 'anthropic':
      return 'yellow';
    case 'openai-codex':
      return 'green';
    case 'unknown':
      return 'gray';
  }
};

/**
 * Compact provider tag for the header — full names overflow narrow
 * terminals (and existing TUI snapshots assume a tight header). Two-to
 * three-letter codes keep the header readable on 100-column ttys.
 */
const providerShortLabel = (kind: ProviderKindLabel): string => {
  switch (kind) {
    case 'openrouter':
      return 'OR';
    case 'anthropic':
      return 'AN';
    case 'openai-codex':
      return 'OAI';
    case 'unknown':
      return '?';
  }
};

/** Long-form provider label for the system-prompt self-knowledge block. */
const providerLongLabel = (kind: ProviderKindLabel): string => {
  switch (kind) {
    case 'openrouter':
      return 'OpenRouter';
    case 'anthropic':
      return 'Anthropic';
    case 'openai-codex':
      return 'OpenAI (ChatGPT/Codex backend)';
    case 'unknown':
      return 'unknown';
  }
};

/**
 * Lightweight inline-markdown renderer for assistant text. Recognises
 * `**bold**`, `*italic*` / `_italic_`, `` `code` ``, ~~strike~~, and
 * fenced ```code blocks``` (rendered as a bordered box with a copy
 * hint — press Ctrl+Y to copy the most recent block).
 */
const Markdown = ({ text }: { text: string }): React.JSX.Element => {
  const lines = text.split('\n');
  // Group consecutive lines between ``` fences into a CodeBlock; everything
  // else becomes a plain Text row with inline markdown.
  const blocks: React.JSX.Element[] = [];
  let buf: string[] = [];
  let inFence = false;
  let lang = '';
  let codeBuf: string[] = [];
  let blockIdx = 0;
  const flushPlain = (): void => {
    if (buf.length === 0) return;
    const slice = buf;
    buf = [];
    blocks.push(
      <Box flexDirection="column" key={`p${blockIdx++}`}>
        {slice.map((line, i) => (
          <Text key={i}>{renderInlineMarkdown(line)}</Text>
        ))}
      </Box>
    );
  };
  for (const rawLine of lines) {
    // Strip trailing CR + ignore leading whitespace when matching fences
    // so models that indent code blocks (or emit CRLF) still get their
    // closing ``` recognized — otherwise the rest of the message ends
    // up rendered inside the code block. Any line whose first non-space
    // characters are 3+ backticks is treated as a fence toggle; the
    // info string after is captured only on opening.
    const line = rawLine.replace(/\r$/, '');
    const fence = line.match(/^\s{0,3}(`{3,})\s*(.*)$/);
    if (fence && fence[1]) {
      if (inFence) {
        // Any ```-prefixed line closes the current block — even if the
        // model added a trailing info string by mistake. Avoids prose
        // spilling into the code block when the close is malformed.
        const code = codeBuf.join('\n');
        codeBuf = [];
        inFence = false;
        flushPlain();
        blocks.push(<CodeBlock key={`c${blockIdx++}`} lang={lang} code={code} />);
        lang = '';
      } else {
        flushPlain();
        inFence = true;
        // First word of the info string is the language hint.
        const info = (fence[2] ?? '').trim();
        lang = info.split(/\s+/)[0] ?? '';
      }
      continue;
    }
    if (inFence) codeBuf.push(line);
    else buf.push(line);
  }
  if (inFence) {
    // Unclosed fence — render whatever we collected as a code block so the
    // streaming view shows code as it lands rather than withholding it.
    flushPlain();
    blocks.push(<CodeBlock key={`c${blockIdx++}`} lang={lang} code={codeBuf.join('\n')} />);
  } else {
    flushPlain();
  }
  return <Box flexDirection="column">{blocks}</Box>;
};

/**
 * A bordered fenced-code-block.
 */
const CodeBlock = ({ lang, code }: { lang: string; code: string }): React.JSX.Element => {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
      <Box>
        <Text color="gray" dimColor>
          {lang ? `◦ ${lang}` : '◦ code'}
        </Text>
        <Box flexGrow={1} />
        <Text color="gray" dimColor>
          Ctrl-Y copy
        </Text>
      </Box>
      {code.split('\n').map((line, i) => (
        <Text key={i} color="yellow">
          {line}
        </Text>
      ))}
    </Box>
  );
};

/**
 * Scan a transcript text for fenced code blocks and return the LAST one
 * (full content, not truncated to the visible window). Used by Ctrl+Y
 * so users can copy long code blocks that scroll off-screen.
 */
const extractLastCodeBlock = (text: string): string | null => {
  const lines = text.split('\n');
  let inFence = false;
  let buf: string[] = [];
  let last: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (/^\s{0,3}`{3,}/.test(line)) {
      if (inFence) {
        last = buf.join('\n');
        buf = [];
        inFence = false;
      } else {
        inFence = true;
        buf = [];
      }
      continue;
    }
    if (inFence) buf.push(line);
  }
  // Unclosed fence at end of text — still return what we have so the user
  // can copy partial blocks while a stream is in flight.
  if (inFence && buf.length > 0) last = buf.join('\n');
  return last;
};

const renderInlineMarkdown = (line: string): React.ReactNode[] => {
  const out: React.ReactNode[] = [];
  let buf = '';
  let i = 0;
  const flushBuf = (): void => {
    if (buf.length > 0) {
      out.push(buf);
      buf = '';
    }
  };
  const matchPair = (open: string, close: string): number => {
    if (line.slice(i, i + open.length) !== open) return -1;
    return line.indexOf(close, i + open.length);
  };
  while (i < line.length) {
    let end = matchPair('**', '**');
    if (end > 0) {
      flushBuf();
      out.push(
        <Text key={`b${i}`} bold>
          {line.slice(i + 2, end)}
        </Text>
      );
      i = end + 2;
      continue;
    }
    end = matchPair('`', '`');
    if (end > 0) {
      flushBuf();
      out.push(
        <Text key={`c${i}`} color="yellow">
          {line.slice(i + 1, end)}
        </Text>
      );
      i = end + 1;
      continue;
    }
    end = matchPair('~~', '~~');
    if (end > 0) {
      flushBuf();
      out.push(
        <Text key={`s${i}`} strikethrough>
          {line.slice(i + 2, end)}
        </Text>
      );
      i = end + 2;
      continue;
    }
    const charNow = line[i];
    if ((charNow === '*' || charNow === '_') && line[i + 1] !== charNow) {
      const closer = line.indexOf(charNow, i + 1);
      const prevCh = i === 0 ? '' : line[i - 1] ?? '';
      const nextCh = closer >= 0 ? line[closer + 1] ?? '' : '';
      const okLeft = prevCh === '' || /[\s(\[{>]/.test(prevCh);
      const okRight = nextCh === '' || /[\s)\].,!?:;>]/.test(nextCh);
      if (closer > i + 1 && okLeft && okRight) {
        flushBuf();
        out.push(
          <Text key={`i${i}`} italic>
            {line.slice(i + 1, closer)}
          </Text>
        );
        i = closer + 1;
        continue;
      }
    }
    buf += line[i];
    i += 1;
  }
  flushBuf();
  return out;
};

const TranscriptRow = ({ item }: { item: TranscriptItem }): React.JSX.Element => {
  switch (item.kind) {
    case 'user':
      return (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
        >
          <Text color="cyan" bold>
            user
          </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case 'assistant': {
      const author = item.author ?? 'assistant';
      const color = colorForAgent(author);
      return (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor={color}
          paddingX={1}
        >
          <Text color={color} bold>
            {author}
          </Text>
          <Markdown text={item.text} />
        </Box>
      );
    }
    case 'thinking':
      return (
        <Box>
          <Text color="magenta" dimColor italic>
            ⌁ {item.text}
          </Text>
        </Box>
      );
    case 'tool': {
      // Lines containing a `\u0001..\u0001` segment render the wrapped
      // text bold (used to highlight tool names) and the rest dim cyan
      // so multi-tool turns stay scannable.
      const text = item.text;
      const m = text.match(/^(.*?)\u0001(.+?)\u0001(.*)$/);
      if (m) {
        return (
          <Box>
            <Text color="cyan">{m[1]}</Text>
            <Text color="cyan" bold>{m[2]}</Text>
            <Text color="cyan">{m[3]}</Text>
          </Box>
        );
      }
      return (
        <Box>
          <Text color="cyan">{text}</Text>
        </Box>
      );
    }
    case 'system':
      return (
        <Box>
          <Text color="gray" italic>
            {item.text}
          </Text>
        </Box>
      );
    case 'error':
      return (
        <Box>
          <Text color="red">{item.text}</Text>
        </Box>
      );
  }
};

const OverlayBox = ({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element => (
  <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
    <Text bold color="cyan">
      {title}
    </Text>
    <Box marginTop={1} flexDirection="column">
      {children}
    </Box>
  </Box>
);

/**
 * Scrollable picker that supports non-selectable section headers. Arrow
 * keys jump straight from item to item (skipping headers), the visible
 * window auto-scrolls to keep the cursor in view, and headers render in
 * a distinct color so users can see provider boundaries at a glance.
 *
 * We can't use `ink-select-input` for this — it treats every row as
 * selectable, so the cursor would land on `── OpenRouter ──` rows and
 * Enter would do nothing.
 */
type PickerEntry =
  | { readonly kind: 'header'; readonly key: string; readonly label: string }
  | {
      readonly kind: 'item';
      readonly key: string;
      readonly label: string;
      readonly value: string;
      readonly pinned?: boolean;
    };

const GroupedPicker = ({
  items,
  limit,
  onSelect
}: {
  readonly items: readonly PickerEntry[];
  readonly limit: number;
  readonly onSelect: (item: { value: string }) => void;
}): React.JSX.Element => {
  const itemEntryIdx = useMemo(() => {
    const out: number[] = [];
    items.forEach((e, i) => {
      if (e.kind === 'item') out.push(i);
    });
    return out;
  }, [items]);
  const [cursor, setCursor] = useState(0);
  const cur = itemEntryIdx.length === 0 ? 0 : Math.min(cursor, itemEntryIdx.length - 1);
  const cursorEntry = itemEntryIdx[cur] ?? 0;
  const [start, setStart] = useState(0);
  const effLimit = Math.max(3, limit);
  // Keep the cursor inside the visible window. Anchor headers above the
  // cursor when possible so the user always knows which group they're in.
  let winStart = start;
  if (cursorEntry < winStart) winStart = cursorEntry;
  if (cursorEntry >= winStart + effLimit) winStart = cursorEntry - effLimit + 1;
  if (winStart > 0) {
    // Scroll up one extra row to keep the section header visible if there
    // is one immediately above the cursor.
    const prev = items[winStart - 1];
    if (prev && prev.kind === 'header' && winStart === cursorEntry) {
      winStart -= 1;
    }
  }
  winStart = Math.max(0, Math.min(winStart, Math.max(0, items.length - effLimit)));
  if (winStart !== start) {
    // Defer state update; React tolerates render-time setState only when
    // it's the same value, but we want to persist the clamp.
    queueMicrotask(() => setStart(winStart));
  }
  const winEnd = Math.min(items.length, winStart + effLimit);
  useInput((_char, key) => {
    if (itemEntryIdx.length === 0) return;
    if (key.upArrow) {
      setCursor((p) => (p <= 0 ? itemEntryIdx.length - 1 : p - 1));
    } else if (key.downArrow) {
      setCursor((p) => (p >= itemEntryIdx.length - 1 ? 0 : p + 1));
    } else if (key.return) {
      const idx = itemEntryIdx[cur];
      if (idx === undefined) return;
      const e = items[idx];
      if (e && e.kind === 'item') onSelect({ value: e.value });
    }
  });
  return (
    <Box flexDirection="column">
      {winStart > 0 && (
        <Text color="gray" dimColor>
          ↑ {winStart} above
        </Text>
      )}
      {items.slice(winStart, winEnd).map((e, i) => {
        const idx = winStart + i;
        if (e.kind === 'header') {
          return (
            <Text key={e.key} color="magenta" bold>
              {e.label}
            </Text>
          );
        }
        const sel = idx === cursorEntry;
        const baseColor = e.pinned ? 'yellow' : undefined;
        const color = sel ? 'green' : baseColor;
        const prefix = sel ? '❯ ' : e.pinned ? '★ ' : '  ';
        return (
          <Text key={e.key} color={color} bold={e.pinned && !sel}>
            {prefix}
            {e.label}
          </Text>
        );
      })}
      {winEnd < items.length && (
        <Text color="gray" dimColor>
          ↓ {items.length - winEnd} below
        </Text>
      )}
    </Box>
  );
};

const StatusBar = ({
  pendingExit,
  streaming,
  mode
}: {
  pendingExit: boolean;
  streaming: boolean;
  mode: Mode;
}): React.JSX.Element => (
  <Box>
    <Text color="gray" dimColor>
      Tab agent · Ctrl-O model · Ctrl-T think · Ctrl-P mode · PgUp/PgDn scroll · Ctrl-Y copy ·{' '}
      {streaming ? 'Esc/Ctrl-C cancel' : '↵ send'} ·{' '}
      {pendingExit ? <Text color="yellow">Ctrl-D again to exit</Text> : 'Ctrl-D ×2 exit'}
    </Text>
    {mode === 'autopilot' && (
      <Text color="red" bold>
        {'  '}⚠ AUTOPILOT
      </Text>
    )}
  </Box>
);

const modeColor = (mode: Mode): string => {
  switch (mode) {
    case 'plan':
      return 'yellow';
    case 'build':
      return 'green';
    case 'autopilot':
      return 'red';
  }
};

const phaseColor = (phase: Phase): string => {
  switch (phase) {
    case 'idle':
      return 'gray';
    case 'discover':
      return 'cyan';
    case 'plan':
      return 'magenta';
    case 'execute':
      return 'yellow';
    case 'verify':
      return 'blue';
    case 'ship':
      return 'green';
  }
};

interface SlashCommand {
  readonly name: string;
  readonly args?: string;
  readonly summary: string;
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'help', summary: 'show this list' },
  { name: 'clear', summary: 'clear the conversation' },
  { name: 'history', summary: 'print the message history' },
  { name: 'model', args: '<id>', summary: 'switch model (no arg → open picker)' },
  { name: 'models', summary: 'open the model picker' },
  { name: 'restart', args: 'models', summary: 'force-refresh the live model catalog (skip 24h cache)' },
  { name: 'agent', args: '<name> [model]', summary: 'switch agent (or bind a model to it)' },
  { name: 'agents', summary: 'list installed agents and their bound models' },
  { name: 'mode', args: 'plan|build|autopilot', summary: 'set permission mode' },
  { name: 'thinking', args: 'off|low|medium|high|xhigh', summary: 'set reasoning effort (model-aware)' },
  { name: 'config', summary: 'open the config menu (API keys, OAuth, integrations)' },
  { name: 'mcps', args: '[add|enable <name>|disable <name>|remove <name>]', summary: 'list / add / toggle / remove MCP servers' },
  { name: 'sessions', args: '[id]', summary: 'list / resume saved sessions' },
  { name: 'resume', args: '[id]', summary: 'resume a session (alias of /sessions)' },
  { name: 'compact', args: '[now|status|on|off|model [id]|threshold <0..1>]', summary: 'auto-compaction controls' },
  { name: 'learn', args: '[on|off|status]', summary: 'self-improvement loop: distill the current turn into a learned skill' },
  { name: 'skills', args: '[list|disable <name>|enable <name>]', summary: 'inspect / disable / enable installed skills' },
  { name: 'next', summary: 'ask Atlas which agent or command to run next' },
  { name: 'onboard', summary: 'brownfield onboarding wizard (cost-aware, arrow-key workflow)' },
  { name: 'tools', summary: 'browse / enable / disable / install built-in tools (web_search, browser, …)' },
  { name: 'status', summary: 'show current workflow phase and active task' },
  { name: 'back', args: '<phase>', summary: 'rewind the workflow to an earlier phase' },
  { name: 'skip', summary: 'jump forward to the next workflow phase' },
  { name: 'abort', summary: 'abandon the current task (state preserved)' },
  { name: 'exit', summary: 'leave atlas' }
];

const SLASH_HELP = SLASH_COMMANDS.map((c) => {
  const head = `/${c.name}${c.args ? ` ${c.args}` : ''}`;
  return `${head.padEnd(28)} ${c.summary}`;
}).join('\n');

/**
 * Returns the slash commands matching the current input.
 *
 *   ""        → []                (no popup unless input starts with /)
 *   "/"       → all commands      (browse the full list)
 *   "/he"     → help              (prefix-filtered)
 *   "/help "  → []                (already complete + space → suppress popup)
 */
const matchSlashCommands = (input: string): readonly SlashCommand[] => {
  if (!input.startsWith('/')) return [];
  const head = input.slice(1);
  if (head.includes(' ')) return [];
  if (head.length === 0) return SLASH_COMMANDS;
  const lower = head.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(lower));
};

/**
 * Minimal controlled text input that respects modifier keys. Unlike
 * `ink-text-input` we explicitly drop characters whose ctrl/meta modifier
 * is set, so global shortcuts like Ctrl-T / Ctrl-O / Ctrl-P don't leak
 * the literal letter into the typed value.
 *
 * Supports: printable insert, Backspace/Delete, ←/→, Home/End, Enter (submit).
 * Cursor is rendered inline with a reverse-color block.
 */
const TextInput = ({
  value,
  onChange,
  onSubmit,
  placeholder,
  mask,
  focus = true
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: (final: string) => void;
  placeholder?: string;
  mask?: string;
  focus?: boolean;
}): React.JSX.Element => {
  const [cursor, setCursor] = useState<number>(value.length);

  // Keep cursor inside the value when it changes externally (e.g. slash completion).
  useEffect(() => {
    setCursor((c) => Math.min(c, value.length));
  }, [value.length]);

  useInput(
    (char, key) => {
      // Alt+Enter / Option+Enter inserts a newline. Most terminals send
      // this as ESC + CR, which Ink surfaces as `key.meta && key.return`.
      if (key.meta && key.return) {
        const next = value.slice(0, cursor) + '\n' + value.slice(cursor);
        setCursor(cursor + 1);
        onChange(next);
        return;
      }
      // Modern terminals with kitty / xterm modifyOtherKeys send a CSI-u
      // sequence for Shift+Enter (e.g. "\x1b[13;2u"). Ink doesn't decode
      // it, so it arrives in `char`. Catch it (and a few common variants)
      // and convert to a newline insert instead of letting the raw escape
      // get pasted into the textbox as garbage.
      if (char && /\x1b\[13;[0-9]+u/.test(char)) {
        const next = value.slice(0, cursor) + '\n' + value.slice(cursor);
        setCursor(cursor + 1);
        onChange(next);
        return;
      }
      // Ignore anything else with a modifier — those are global shortcuts.
      if (key.ctrl || key.meta) return;
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        const next = value.slice(0, cursor - 1) + value.slice(cursor);
        setCursor(cursor - 1);
        onChange(next);
        return;
      }
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }
      // Up/Down arrows are reserved for parent (slash palette / history).
      if (key.upArrow || key.downArrow) return;
      // Tab is reserved for parent (slash completion / agent cycle).
      if (key.tab) return;
      if (key.escape) return;
      // Insert printable text. `char` may contain a multi-char paste.
      if (char && char.length > 0) {
        // Strip CSI-u modifier sequences that snuck through (Shift+Enter
        // already handled above, but other Shift+key combos can produce
        // similar escapes that would otherwise become visible garbage).
        let cleaned = char.replace(/\x1b\[\d+(;\d+)?u/g, '');
        // Preserve real newlines in pastes (multi-line clipboard content)
        // by stripping only the *other* control chars.
        cleaned = cleaned.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
        if (cleaned.length === 0) return;
        const next = value.slice(0, cursor) + cleaned + value.slice(cursor);
        setCursor(cursor + cleaned.length);
        onChange(next);
      }
    },
    { isActive: focus }
  );

  const display = mask ? mask.repeat(value.length) : value;
  if (value.length === 0 && placeholder) {
    return <Text color="gray">{placeholder}</Text>;
  }
  // Render with an inline cursor block.
  const before = display.slice(0, cursor);
  const at = display.slice(cursor, cursor + 1) || ' ';
  const after = display.slice(cursor + 1);
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
};

const SlashAutocomplete = ({
  matches,
  activeIdx
}: {
  matches: readonly SlashCommand[];
  activeIdx: number;
}): React.JSX.Element | null => {
  if (matches.length === 0) return null;
  // Window the visible slice so the highlighted row stays on screen
  // when there are more than 8 matches.
  const MAX = 8;
  const start =
    matches.length <= MAX
      ? 0
      : Math.min(Math.max(0, activeIdx - Math.floor(MAX / 2)), matches.length - MAX);
  const visible = matches.slice(start, start + MAX);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={0}>
      {visible.map((c, i) => {
        const idx = start + i;
        const active = idx === activeIdx;
        return (
          <Box key={c.name}>
            <Text color={active ? 'cyanBright' : 'gray'}>{active ? '› ' : '  '}</Text>
            <Text color={active ? 'cyanBright' : 'cyan'} bold={active}>
              /{c.name}
            </Text>
            {c.args && <Text color="gray">{` ${c.args}`}</Text>}
            <Text color="gray">{`  ${c.summary}`}</Text>
          </Box>
        );
      })}
      {matches.length > MAX && (
        <Text color="gray" dimColor>
          {`${activeIdx + 1}/${matches.length} · ↑↓ select · Tab complete · Enter run`}
        </Text>
      )}
      {matches.length <= MAX && matches.length > 1 && (
        <Text color="gray" dimColor>
          ↑↓ select · Tab complete · Enter run
        </Text>
      )}
    </Box>
  );
};

/**
 * The Atlas startup splash — a tiny ASCII octopus next to the wordmark.
 * Drawn once at the top of the transcript; not part of the chat history.
 */
const Splash = ({ defaultModel }: { defaultModel: string }): React.JSX.Element => (
  <Box flexDirection="row" marginY={1} paddingX={1}>
    <Box flexDirection="column" marginRight={2}>
      <Text color="blue">{`     ___`}</Text>
      <Text color="blue">{`   /     \\`}</Text>
      <Text color="blueBright">{`  | () () |`}</Text>
      <Text color="blue">{`   \\  ^  /`}</Text>
      <Text color="cyan">{`   //|||\\\\`}</Text>
      <Text color="cyan">{`  // | | \\\\`}</Text>
    </Box>
    <Box flexDirection="column">
      <Text color="cyanBright" bold>{`Atlas CLI`}</Text>
      <Text color="gray">spec-driven development crew</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">model · <Text color="white">{defaultModel}</Text></Text>
        <Text color="gray">type <Text color="cyan">/</Text> for commands · <Text color="cyan">Tab</Text> to switch agent</Text>
        <Text color="gray">press <Text color="cyan">Ctrl-D</Text> twice to exit (Ctrl-C cancels)</Text>
      </Box>
    </Box>
  </Box>
);

const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`);
const truncateArgs = (s: string): string => truncate(s.replace(/\s+/g, ' '), 80);

/** Render a millisecond duration as a compact human label (e.g. "1.2s", "340ms"). */
const formatElapsed = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
};

/** Remove every `<atlas:question>...</atlas:question>` block from a string. */
const stripInteractionBlocks = (s: string): string =>
  s.replace(/<atlas:question>[\s\S]*?<\/atlas:question>/g, '').trim();

/**
 * Strip *complete* interaction blocks and also hide an *in-progress*
 * (still-streaming) one — i.e. truncate at the first opening tag if its
 * closer hasn't arrived yet. Keeps the live transcript free of raw
 * protocol noise while the model is mid-question.
 */
const renderVisibleAssistant = (buf: string): string => {
  const stripped = buf.replace(/<atlas:question>[\s\S]*?<\/atlas:question>/g, '');
  const open = stripped.indexOf('<atlas:question>');
  return (open >= 0 ? stripped.slice(0, open) : stripped).trimEnd();
};

/**
 * Best-effort browser opener. We don't `await` the child process — the
 * shell command exits immediately after handing off to the OS opener.
 * Failures are non-fatal: the caller still prints the URL so the user
 * can copy it manually.
 */
const openInBrowser = async (url: string): Promise<void> => {
  const plat = platform();
  let cmd: string;
  let args: string[];
  if (plat === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (plat === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* swallow — caller still has the URL on screen */
    });
    child.unref();
  } catch {
    /* swallow */
  }
};

/**
 * Best-effort fuzzy match: given user input like "depsek4" and a list
 * of candidate model ids, return the closest match (case-insensitive,
 * tolerant of dropped/transposed chars). Returns `null` if nothing is
 * within reasonable edit distance.
 */
const resolveFuzzyModel = (
  query: string,
  candidates: readonly string[]
): string | null => {
  if (candidates.length === 0) return null;
  const q = query.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (q.length === 0) return null;
  // 1. Exact (post-normalize) match.
  for (const c of candidates) {
    if (c.toLowerCase().replace(/[^a-z0-9]/g, '') === q) return c;
  }
  // 2. Normalized substring — query appears inside the candidate id.
  const subs = candidates.filter((c) =>
    c.toLowerCase().replace(/[^a-z0-9]/g, '').includes(q)
  );
  if (subs.length > 0) {
    // Prefer the shortest matching id (closest fit).
    return subs.reduce((a, b) => (a.length <= b.length ? a : b));
  }
  // 3. Edit-distance fallback — pick the closest within distance ≤ q/3.
  let best: { id: string; d: number } | null = null;
  for (const c of candidates) {
    const norm = c.toLowerCase().replace(/[^a-z0-9]/g, '');
    const d = levenshtein(q, norm);
    if (best === null || d < best.d) best = { id: c, d };
  }
  if (best && best.d <= Math.max(2, Math.floor(q.length / 3))) return best.id;
  return null;
};

const levenshtein = (a: string, b: string): number => {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (cur[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j] ?? 0;
  }
  return prev[b.length] ?? 0;
};

// Re-export for tests.
export { THINKING_CYCLE };
