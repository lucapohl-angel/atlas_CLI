/** @jsxImportSource @opentui/react */
/**
 * OpenTUI variant of the Atlas TUI.
 *
 * Phases 1-8: runtime + visual identity + interactive pickers + multi-line
 * composer + slash-command router.
 *
 *   Phase 3  Tab          → agent picker
 *   Phase 4  Ctrl-O       → model picker
 *   Phase 5  Ctrl-T       → thinking-effort picker
 *   Phase 6  Ctrl-P       → mode picker
 *   Phase 7  composer     → `<textarea>` (Enter sends, Ctrl-J newline)
 *   Phase 8  slash router → /help /clear /history /quit /agent /model
 *                          /agents /models /thinking /mode
 *
 * Behavior parity for the heavier overlays (setup wizard, autopilot
 * confirm, sessions, MCP, ship-conflict, full live telemetry, markdown
 * transcript) lands in subsequent slices. This file remains the entry
 * point for the OpenTUI runtime and is feature-flagged behind
 * `--ui=opentui`.
 *
 * Runtime requirement: OpenTUI uses `node:ffi`, which is only
 * available in Bun. The dispatcher (`launcher.mjs`) routes users to
 * the bundled Bun binary by default; running this file under Node
 * throws a clear error at boot.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  allowAllPolicy,
  ATLAS_POWER_MODE_SPECS,
  saveLearnedSkill,
  ATLAS_VERSION,
  buildSystemPrompt,
  childLogger,
  canRewindTo,
  classifyIntent,
  clearActiveTask,
  compactIfNeeded,
  consumeDiscoverWarnings,
  denyAllPolicy,
  estimateCost,
  estimateOnboardCost,
  findOnboardingDocs,
  type OnboardingDocCandidate,
  fetchAnthropicModels,
  fetchCodexModels,
  fetchOpenRouterModels,
  formatPhaseLine,
  isFrameworkAgent,
  loadClaudeCodeCredentials,
  loadContextPack,
  LOCAL_HYBRID_TOOL_NAMES,
  LOCAL_TOOL_MODE_SPECS,
  findSuggestion,
  PHASES,
  phasePromptAddendum,
  readSignals,
  resolveCatalogStatus,
  runAgentLoop,
  runToolAction,
  saveConfig,
  setSkillDisabled,
  startTask,
  thinkingLevelsFor,
  titleFromMessage,
  tryExtractInteraction,
  updateTask,
  writeRepoMap,
  type Agent,
  type AgentRegistry,
  type ApprovalDecision,
  type ApprovalPolicy,
  type AtlasPowerMode,
  type AtlasConfig,
  type HookRegistry,
  type InteractionRequest,
  type LocalProviderToolMode,
  type LoopEvent,
  type McpServerConfig,
  type Message,
  type ModelInfo,
  type OnboardPreflight,
  type ResolvedToolStatus,  type Phase,
  type Provider,
  type ReasoningEffort,
  type ReasoningOptions,
  type SessionStore,
  type SessionRecord,
  type SkillRegistry,
  type TaskState,
  type ThinkingLevel,
  type ToolContext,
  type ToolRegistry
} from '@atlas/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { TextareaRenderable } from '@opentui/core';
import { createTextAttributes } from '@opentui/core';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import {
  buildReflectionMessages,
  buildSkillRevisionMessages,
  DEFAULT_AUTO_LEARN_ENABLED,
  describeLearnReason,
  parseLearnedSkillDraft,
  shouldOfferLearn,
  type LearnedSkillDraft
} from '../learn.js';

const BOLD_ATTR = createTextAttributes({ bold: true });
const ITALIC_ATTR = createTextAttributes({ italic: true });
import { palette } from './palette.js';
import { Splash } from './Splash.js';
import { renderMarkdownBlock } from './markdown.js';
import { styleForTool } from './tool-style.js';
import { Header, type Mode, type ThinkingEffort } from './Header.js';
import { Sidebar, type SidebarToolEvent, type SidebarTodo } from './Sidebar.js';
import {
  ColoredGroupedPicker,
  Confirm,
  InfoOverlay,
  KeyEntry,
  LoadingOverlay,
  MultiSelect,
  Picker,
  SlashAutocomplete,
  type GroupedPickerEntry,
  type MultiSelectAction,
  type PickerOption,
  type SlashSuggestion
} from './Picker.js';

const openTuiLog = childLogger('tui:opentui');

export interface OpenTuiAppProps {
  readonly provider: Provider | null;
  /**
   * Live per-provider runtimes built from config (openrouter / anthropic
   * / openai-codex). Drives the /config menu's connection badges and
   * the model-picker section visibility — same contract as the Ink TUI.
   */
  readonly providers?: Partial<Record<'openrouter' | 'anthropic' | 'openai-codex' | 'local', Provider>>;
  readonly agents: AgentRegistry;
  readonly skills: SkillRegistry;
  readonly tools: ToolRegistry;
  readonly toolContext: ToolContext;
  readonly hooks?: HookRegistry;
  readonly defaultModel: string;
  readonly fallbackModels?: readonly string[];
  readonly availableModels?: readonly string[];
  /**
   * Live model catalog (OpenRouter / Anthropic / Codex) — same shape
   * the Ink TUI consumes. Drives model-picker grouping, thinking-level
   * filtering, context-window sizing, and the provider tag in the
   * header. Optional: the picker falls back to a static seed list.
   */
  readonly modelCatalog?: readonly ModelInfo[];
  readonly initialAgentName?: string;
  readonly config?: AtlasConfig;
  readonly setupError?: string;
  readonly sessionStore?: SessionStore;
  /**
   * Resumed session restored at startup (when invoked with
   * `--resume <id>` or `--continue`). The full record is passed in
   * (not just id+title) so the OpenTUI variant can hydrate the
   * transcript and messagesRef on mount, matching Ink behaviour.
   */
  readonly initialSession?: SessionRecord;
  /** MCP server startup status (running + failed). Surfaced via `/mcps`. */
  readonly mcpStatus?: {
    readonly running: readonly { readonly name: string; readonly toolCount: number }[];
    readonly failed: readonly { readonly name: string; readonly error: string }[];
  };
  /**
   * The active workflow task (if any) restored from
   * `.atlas/active-task.json`. Drives `/status`, `/back`, `/skip`,
   * `/abort`. The OpenTUI variant doesn't yet auto-advance phases on
   * each turn (the Ink TUI's classifyIntent router is heavy state);
   * the user can drive it manually via the four phase commands.
   */
  readonly initialActiveTask?: TaskState | null;
  /** Called when the user requests exit (Ctrl-D twice / Ctrl-C / Esc on empty input). */
  readonly onExit?: () => void;
}

interface TranscriptItem {
  readonly key: string;
  readonly kind: 'user' | 'assistant' | 'system' | 'error' | 'thinking' | 'timeline';
  readonly text: string;
  readonly author?: string;
  /** Frozen turn-timeline steps. Only set when `kind === 'timeline'`. */
  readonly steps?: readonly TurnStep[];
}

/**
 * One row in the per-turn "what is the model doing" timeline. Drives
 * the live VS-Code-style activity strip that appears above the
 * composer while the model is working, and the frozen card that's
 * appended to the transcript when the turn ends. The data is
 * derived from the existing `LoopEvent` stream — there is no extra
 * provider call.
 */
interface TurnStep {
  readonly id: string;
  readonly kind: 'thinking' | 'tool' | 'note';
  /** Verb-prefixed label, e.g. "Reading App.tsx" or "Thinking…". */
  readonly label: string;
  readonly status: 'running' | 'ok' | 'error';
  readonly startedAt: number;
  readonly finishedAt?: number;
  /**
   * One short line of context (first line of a tool result, or the
   * tail of the model's reasoning). Truncated to ~120 chars by the
   * renderer.
   */
  readonly detail?: string;
  /** Tool name — used to look up the icon/color. Tool steps only. */
  readonly toolName?: string;
  /**
   * Optional file basename (rendered yellow next to the verb). Set
   * for read/write/edit/delete steps so the path is visually
   * distinct from the verb and the elapsed time.
   */
  readonly filePath?: string;
  /**
   * Optional shell command preview (rendered purple inside backticks).
   * Set for terminal/exec steps.
   */
  readonly command?: string;
  /**
   * Optional line-count delta — added (+green) and removed (-red),
   * shown after the elapsed time, à la VS Code's diff strip.
   * Set for read (linesAdded only), write (linesAdded only), and
   * edit (both) tool calls.
   */
  readonly linesAdded?: number;
  readonly linesRemoved?: number;
}

/**
 * Structured verb-first label for a tool call. Mirrors VS Code's
 * "Reading file.ts / Edited config.json / Searched 'foo'" — the
 * verb, optional file basename (rendered yellow), and optional
 * shell command (rendered purple) come back as separate fields so
 * the timeline can colorise them. Falls back to the bare tool name
 * for anything we don't recognise so a new MCP tool still shows up
 * sensibly.
 */
interface ToolCallParts {
  readonly verb: string;
  readonly filePath?: string;
  readonly command?: string;
}

const describeToolCall = (
  name: string,
  args: unknown,
  past: boolean
): ToolCallParts => {
  // `args` arrives as the raw JSON string from the provider; parse
  // best-effort so a malformed payload doesn't crash the timeline.
  let parsed: Record<string, unknown> = {};
  if (typeof args === 'string' && args.length > 0) {
    try {
      const v = JSON.parse(args) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        parsed = v as Record<string, unknown>;
      }
    } catch {
      // ignore — we'll just render the bare tool name.
    }
  } else if (args && typeof args === 'object' && !Array.isArray(args)) {
    parsed = args as Record<string, unknown>;
  }
  const a = parsed;
  const baseOf = (v: unknown): string => {
    if (typeof v !== 'string' || v.length === 0) return '';
    const s = v.replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  };
  const truncate = (v: unknown, n: number): string => {
    const s = typeof v === 'string' ? v : '';
    return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
  };
  const path = baseOf(a.path ?? a.filePath ?? a.file ?? a.relativePath ?? a.uri);
  if (/(^|_)read(_|file|dir|page|webpage|skill|notebook)/i.test(name)) {
    return path
      ? { verb: past ? 'Read' : 'Reading', filePath: path }
      : { verb: past ? 'Read' : 'Reading' };
  }
  if (/list_dir|list_files|file_search/i.test(name)) {
    const q = truncate(a.query ?? a.path ?? a.pattern, 40);
    return { verb: past ? 'Listed' : 'Listing', filePath: q || 'files' };
  }
  if (/grep|search/i.test(name) && !/web/i.test(name)) {
    const q = truncate(a.query ?? a.pattern ?? '', 40);
    return q
      ? { verb: `${past ? 'Searched' : 'Searching'} "${q}"` }
      : { verb: past ? 'Searched' : 'Searching' };
  }
  if (/(^|_)write(_|file|notebook)?|create_file|create_directory/i.test(name)) {
    return path
      ? { verb: past ? 'Wrote' : 'Writing', filePath: path }
      : { verb: past ? 'Wrote' : 'Writing' };
  }
  if (/edit|replace_string|multi_replace|insert_edit|edit_notebook|patch/i.test(name)) {
    return path
      ? { verb: past ? 'Edited' : 'Editing', filePath: path }
      : { verb: past ? 'Edited' : 'Editing' };
  }
  if (/delete|remove/i.test(name)) {
    return path
      ? { verb: past ? 'Deleted' : 'Deleting', filePath: path }
      : { verb: past ? 'Deleted' : 'Deleting' };
  }
  if (/web_fetch|fetch_webpage|fetch_url|http_get/i.test(name)) {
    let host = '';
    if (typeof a.url === 'string') {
      try {
        host = new URL(a.url).host;
      } catch {
        host = truncate(a.url, 40);
      }
    } else if (Array.isArray(a.urls) && typeof a.urls[0] === 'string') {
      try {
        host = new URL(a.urls[0]).host;
      } catch {
        host = truncate(a.urls[0], 40);
      }
    }
    return host
      ? { verb: past ? 'Fetched' : 'Fetching', filePath: host }
      : { verb: past ? 'Fetched' : 'Fetching' };
  }
  if (/web_search|search_web/i.test(name)) {
    const q = truncate(a.query ?? '', 40);
    return q
      ? { verb: `${past ? 'Searched web for' : 'Searching web for'} "${q}"` }
      : { verb: past ? 'Searched web' : 'Searching web' };
  }
  if (/run_in_terminal|terminal|shell|exec|run_command/i.test(name)) {
    const cmd = truncate(a.command ?? a.cmd ?? '', 40);
    return cmd
      ? { verb: past ? 'Ran' : 'Running', command: cmd }
      : { verb: past ? 'Ran shell' : 'Running shell' };
  }
  if (/skill/i.test(name)) {
    const id = truncate(a.skill ?? a.name ?? a.id ?? '', 40);
    return id
      ? { verb: past ? 'Read skill' : 'Reading skill', filePath: id }
      : { verb: past ? 'Read skill' : 'Reading skill' };
  }
  if (/think|plan|discover|reason/i.test(name)) {
    return { verb: past ? 'Planned' : 'Planning' };
  }
  if (/ship|git_commit|commit/i.test(name)) {
    return { verb: past ? 'Shipped' : 'Shipping' };
  }
  if (/todo/i.test(name)) {
    return { verb: past ? 'Updated todos' : 'Updating todos' };
  }
  if (/ask_question|user_input/i.test(name)) {
    return { verb: past ? 'Asked you' : 'Asking you' };
  }
  return { verb: past ? `Used ${name}` : `Using ${name}` };
};

/**
 * Compute a `+added / -removed` line delta for a tool call so the
 * timeline can render a VS Code-style diff strip. Reads / writes
 * report the file's line count under `linesAdded`. Edits parse
 * `oldString` / `newString` (or the array of replacements for
 * `multi_replace_string_in_file`) and report both sides.
 *
 * Returns an empty object when the tool either isn't a file op or
 * we can't extract enough info — never throws.
 */
const computeLineStats = (
  name: string,
  args: unknown,
  result: unknown
): { linesAdded?: number; linesRemoved?: number } => {
  // Parse args (mirrors the parser inside describeToolCall — kept
  // local so neither helper needs to allocate a shared cache).
  let a: Record<string, unknown> = {};
  if (typeof args === 'string' && args.length > 0) {
    try {
      const v = JSON.parse(args) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        a = v as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  } else if (args && typeof args === 'object' && !Array.isArray(args)) {
    a = args as Record<string, unknown>;
  }
  const lineCount = (s: unknown): number => {
    if (typeof s !== 'string' || s.length === 0) return 0;
    return s.split('\n').length;
  };
  // Read* — count lines in the result. Tool may return either the
  // file content directly (string) or an object like `{ content }`.
  if (/(^|_)read(_|file|notebook)/i.test(name)) {
    if (typeof result === 'string') return { linesAdded: lineCount(result) };
    if (result && typeof result === 'object') {
      const o = result as Record<string, unknown>;
      const text = o.content ?? o.text ?? o.value;
      if (typeof text === 'string') return { linesAdded: lineCount(text) };
    }
    return {};
  }
  // Write/create — count lines in the args' content payload.
  if (/(^|_)write(_|file)?|create_file/i.test(name)) {
    const text = a.content ?? a.text ?? a.body ?? a.value;
    if (typeof text === 'string') return { linesAdded: lineCount(text) };
    return {};
  }
  // Single-shot edit — diff the two literal blocks.
  if (/replace_string|insert_edit|patch/i.test(name) && !/multi/i.test(name)) {
    const oldStr = a.oldString ?? a.old_str ?? a.search ?? '';
    const newStr = a.newString ?? a.new_str ?? a.replace ?? a.insert_text ?? '';
    return { linesAdded: lineCount(newStr), linesRemoved: lineCount(oldStr) };
  }
  // Multi-edit — sum across the array.
  if (/multi_replace|multi_edit/i.test(name)) {
    const list = a.replacements ?? a.edits ?? a.patches;
    if (Array.isArray(list)) {
      let added = 0;
      let removed = 0;
      for (const r of list) {
        if (r && typeof r === 'object') {
          const o = r as Record<string, unknown>;
          added += lineCount(o.newString ?? o.new_str ?? '');
          removed += lineCount(o.oldString ?? o.old_str ?? '');
        }
      }
      return { linesAdded: added, linesRemoved: removed };
    }
    return {};
  }
  return {};
};

/**
 * Pull the first non-empty line out of an arbitrary tool result so
 * we can render it as the timeline step's secondary line. Strings
 * pass through; objects get JSON-encoded; null/undefined → empty.
 */
const firstLineOf = (v: unknown, max = 120): string => {
  let s: string;
  if (v == null) return '';
  if (typeof v === 'string') s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  }
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line.trim();
};

/** `1.2s` / `342ms` formatter used everywhere in the timeline. */
const fmtElapsed = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

/**
 * Render a single TurnStep as a 1-2 row block. Running steps tick
 * a live elapsed timer (the parent re-renders every 250 ms while a
 * tool is in flight). Done steps render the final elapsed time and
 * a muted detail line.
 *
 * For thinking steps, `revealedChars` lets the parent gate how
 * much of the accumulated reasoning buffer to display so the text
 * appears at a comfortable typewriter pace instead of dumping the
 * full stream the moment it arrives. Pass `Infinity` for frozen
 * thinking steps in the transcript history (everything visible).
 */
/**
 * Convert a workspace-relative or absolute file path into a `file://`
 * URL so OpenTUI's `<text link>` prop can emit an OSC 8 hyperlink.
 * Most modern terminals (iTerm2, Kitty, WezTerm, Ghostty, GNOME
 * Terminal, recent xterm) render OSC 8 sequences as Ctrl+click /
 * ⌘+click targets.
 */
function filePathToUrl(p: string): string {
  const abs = isAbsolute(p) ? p : resolvePath(process.cwd(), p);
  // file:// URLs need each path segment encoded but slashes preserved.
  const encoded = abs
    .split('/')
    .map((seg) => (seg ? encodeURIComponent(seg) : seg))
    .join('/');
  return `file://${encoded}`;
}

const renderStepRow = (
  step: TurnStep,
  keyPrefix: string,
  now: number,
  revealedLines: number = Infinity
): ReactNode => {
  const tool =
    step.kind === 'tool' && step.toolName
      ? styleForTool(step.toolName)
      : { icon: step.kind === 'thinking' ? '[*]' : '[·]', color: palette.accent };
  const glyph =
    step.status === 'running' ? '..' : step.status === 'error' ? 'xx' : 'ok';
  const glyphColor =
    step.status === 'running'
      ? palette.warning
      : step.status === 'error'
        ? palette.error
        : palette.success;
  const labelColor = step.status === 'error' ? palette.error : tool.color;
  const elapsed =
    step.finishedAt !== undefined
      ? step.finishedAt - step.startedAt
      : now - step.startedAt;
  // Compute the visible detail block. Tool steps get one line of
  // result preview. Thinking steps get up to 10 lines of the
  // accumulated reasoning, gated by `revealedLines` for the
  // typewriter effect (one new row roughly every 140 ms).
  let detailLines: readonly string[] = [];
  if (step.kind === 'thinking' && step.detail) {
    const all = step.detail.split('\n').filter((l) => l.trim().length > 0);
    const cap = Number.isFinite(revealedLines)
      ? Math.max(0, Math.min(all.length, revealedLines))
      : all.length;
    const visible = all.slice(0, cap);
    detailLines = visible.slice(-10);
  } else if (step.detail) {
    detailLines = [step.detail];
  }
  return (
    <box
      key={keyPrefix}
      style={{
        flexDirection: 'column',
        backgroundColor: palette.backgroundPanel
      }}
    >
      <box
        style={{
          flexDirection: 'row',
          backgroundColor: palette.backgroundPanel
        }}
      >
        <text fg={glyphColor}>{`${glyph} `}</text>
        <text fg={labelColor}>{`${tool.icon} `}</text>
        <text fg={labelColor} attributes={BOLD_ATTR}>{step.label}</text>
        {step.filePath ? (
          <text fg={palette.warning} attributes={BOLD_ATTR}>
            <a href={filePathToUrl(step.filePath)}>{` ${step.filePath}`}</a>
          </text>
        ) : null}
        {step.command ? (
          <>
            <text fg={palette.textDim}> `</text>
            <text fg={palette.accent}>{step.command}</text>
            <text fg={palette.textDim}>`</text>
          </>
        ) : null}
        <text fg={palette.textDim}>{`  ${fmtElapsed(elapsed)}`}</text>
        {typeof step.linesAdded === 'number' && step.linesAdded > 0 ? (
          <text fg={palette.success}>{`  +${step.linesAdded}`}</text>
        ) : null}
        {typeof step.linesRemoved === 'number' && step.linesRemoved > 0 ? (
          <text fg={palette.error}>{` -${step.linesRemoved}`}</text>
        ) : null}
      </box>
      {detailLines.map((line, i) => (
        <box
          key={`${keyPrefix}_d${i}`}
          style={{
            flexDirection: 'row',
            paddingLeft: 6,
            backgroundColor: palette.backgroundPanel
          }}
        >
          <text fg={palette.textMuted} attributes={ITALIC_ATTR}>{line}</text>
        </box>
      ))}
    </box>
  );
};

/**
 * Render the live / frozen turn-timeline as a plain stack of
 * rows. No border, no nested background — sits flush in the chat
 * scrollback so it doesn't break the surrounding panel color.
 * Visually similar to VS Code Copilot's "Searched, Read, Edited"
 * activity trail above the assistant reply.
 */
const renderTimelineCard = (
  steps: readonly TurnStep[],
  itemKey: string,
  revealedLines: number = Infinity
): ReactNode => {
  if (steps.length === 0) return null;
  const now = Date.now();
  return (
    <box
      style={{
        width: '100%',
        flexDirection: 'column',
        backgroundColor: palette.backgroundPanel
      }}
    >
      {steps.map((s, i) =>
        renderStepRow(s, `${itemKey}_s${i}`, now, revealedLines)
      )}
    </box>
  );
};

type OverlayKind =
  | 'agent'
  | 'model'
  | 'model-add'
  | 'thinking'
  | 'mode'
  | 'autopilot-confirm'
  | 'tool-approval'
  | 'config'
  | 'config-key-openrouter'
  | 'config-key-anthropic'
  | 'config-mcp'
  | 'config-mcp-action'
  | 'config-mcp-add-env'
  | 'config-mcp-add-confirm'
  | 'config-mcp-custom'
  | 'config-ship'
  | 'config-atlas-power'
  | 'config-info'
  | 'mcps-manage'
  | 'mcps-actions'
  | 'sessions-list'
  | 'sessions-actions'
  | 'sessions-delete-select'
  | 'sessions-delete-confirm'
  | 'option-picker'
  | 'option-freeform'
  | 'tools-list'
  | 'tools-actions'
  | 'onboard-loading'
  | 'onboard-existing-docs'
  | 'onboard-mode'
  | 'onboard-strategy'
  | 'onboard-pick-model'
  | 'onboard-confirm'
  | 'onboard-running'
  | 'copy-picker'
  | 'skills-list'
  | 'skills-actions'
  | 'sessions-rename'
  | 'config-action-openrouter'
  | 'config-action-anthropic'
  | 'config-local'
  | 'learn-confirm'
  | 'ship-conflict';

/**
 * Companion state for the `learn-confirm` overlay. Held in its own
 * useState (rather than baked into OverlayKind) so flipping the
 * overlay channel doesn't force a wholesale type refactor — every
 * other overlay is a plain string and we want to keep it that way.
 */
interface LearnConfirmState {
  readonly stage: 'reflecting' | 'review' | 'saving' | 'change';
  readonly reason: string;
  readonly draft?: LearnedSkillDraft;
  readonly error?: string;
}

interface ToolApprovalState {
  readonly tool: string;
  readonly inputPreview: string;
}

const STATUSBAR =
  'Tab agent · Ctrl-O model · Ctrl-T think · Ctrl-P mode · Ctrl-X copy · ↵ send · Ctrl-J newline · Ctrl-D ×2 exit';

const formatSkillDraftPreview = (draft: LearnedSkillDraft): string =>
  [
    '---',
    `name: ${draft.name}`,
    `description: ${draft.description}`,
    `triggers: ${JSON.stringify([...draft.triggers])}`,
    'kind: learned',
    '---',
    draft.body.trim()
  ].join('\n');

const wrapOverlayLine = (line: string, width: number): readonly string[] => {
  if (line.length === 0) return [''];
  const out: string[] = [];
  for (let i = 0; i < line.length; i += width) {
    out.push(line.slice(i, i + width));
  }
  return out;
};

const estimateContextTokens = (messages: readonly Message[]): number => {
  const chars = messages.reduce((sum, m) => {
    const toolCallChars = (m.toolCalls ?? []).reduce(
      (inner, tc) => inner + tc.name.length + tc.arguments.length,
      0
    );
    return (
      sum +
      m.content.length +
      toolCallChars +
      (m.name?.length ?? 0) +
      (m.toolCallId?.length ?? 0)
    );
  }, 0);
  return Math.ceil(chars / 4);
};

const formatApprovalInputPreview = (input: unknown): string => {
  let raw: string;
  try {
    raw = JSON.stringify(input, null, 2);
  } catch {
    raw = String(input);
  }
  return raw.length > 1200 ? `${raw.slice(0, 1200)}\n...[truncated]` : raw;
};

interface LearnReflectingOverlayProps {
  readonly reason: string;
  readonly revising: boolean;
}

const LearnReflectingOverlay = (props: LearnReflectingOverlayProps) => {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    setElapsedSeconds(0);
    const id = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [props.reason, props.revising]);
  const action = props.revising ? 'Reworking the draft' : 'Reflecting on the last turn';
  const elapsed = elapsedSeconds > 0 ? ` (${elapsedSeconds}s)` : '';
  return (
    <LoadingOverlay
      title="atlas is drafting a learned skill"
      body={`${action}...${elapsed}\nTrigger: ${props.reason}`}
      hint="Esc / Ctrl-C cancel"
    />
  );
};

interface LearnDraftReviewOverlayProps {
  readonly draft: LearnedSkillDraft;
  readonly reason: string;
  readonly error?: string;
  readonly onSave: () => void;
  readonly onReject: () => void;
  readonly onChange: () => void;
}

const LearnDraftReviewOverlay = (props: LearnDraftReviewOverlayProps) => {
  const { width: cols, height: rows } = useTerminalDimensions();
  const overlayWidth = Math.min(104, Math.max(62, cols - 4));
  const overlayHeight = Math.min(34, Math.max(20, rows - 4));
  const left = Math.max(2, Math.floor((cols - overlayWidth) / 2));
  const top = Math.max(2, Math.floor((rows - overlayHeight) / 2));
  const bodyWidth = Math.max(24, overlayWidth - 4);
  const bodyHeight = Math.max(6, overlayHeight - (props.error ? 13 : 12));
  const actions = ['save', 'change', 'reject'] as const;
  const [actionIdx, setActionIdx] = useState<number>(0);
  // The body is a native `<scrollbox>` rather than a manual offset
  // slice — the prior version relied on `useKeyboard` firing on this
  // child component, which failed in some terminals (arrow keys never
  // updated `scrollOffset`). With `<scrollbox>` OpenTUI handles up /
  // down / pageup / pagedown and even mouse-wheel internally as long
  // as the box is focused.
  const lines = useMemo(
    () =>
      formatSkillDraftPreview(props.draft)
        .split('\n')
        .flatMap((line) => wrapOverlayLine(line, bodyWidth)),
    [props.draft, bodyWidth]
  );

  const runAction = useCallback(
    (action: (typeof actions)[number]): void => {
      if (action === 'save') props.onSave();
      else if (action === 'change') props.onChange();
      else props.onReject();
    },
    [props]
  );

  useKeyboard((key) => {
    if (key.name === 'return') {
      runAction(actions[actionIdx] ?? 'save');
      return;
    }
    if (key.name === 'tab' || key.name === 'right') {
      setActionIdx((i) => (i + 1) % actions.length);
      return;
    }
    if (key.name === 'left') {
      setActionIdx((i) => (i - 1 + actions.length) % actions.length);
      return;
    }
    if (key.sequence === 's') runAction('save');
    else if (key.sequence === 'c') runAction('change');
    else if (key.sequence === 'r') runAction('reject');
  });

  return (
    <box
      style={{
        position: 'absolute',
        top,
        left,
        width: overlayWidth,
        height: overlayHeight,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: props.error ? palette.error : palette.primary,
        backgroundColor: palette.backgroundElement,
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <text fg={palette.primaryBright}>{`✦ learned skill draft · ${props.draft.name}`}</text>
      <text fg={palette.textMuted}>{props.draft.description}</text>
      <text fg={palette.textDim}>
        {`triggers: ${props.draft.triggers.join(', ') || '(none)'}`}
      </text>
      <text fg={palette.textDim}>{`reason: ${props.reason} · ${lines.length} lines`}</text>
      {props.error ? <text fg={palette.error}>{`save failed: ${props.error}`}</text> : null}
      <scrollbox
        focused
        style={{
          height: bodyHeight,
          marginTop: 1,
          marginBottom: 1,
          backgroundColor: palette.backgroundPanel,
          paddingLeft: 1,
          paddingRight: 1
        }}
        rootOptions={{ backgroundColor: palette.backgroundPanel }}
        wrapperOptions={{ backgroundColor: palette.backgroundPanel }}
        viewportOptions={{ backgroundColor: palette.backgroundPanel }}
        contentOptions={{ backgroundColor: palette.backgroundPanel }}
        stickyScroll={false}
      >
        {lines.map((line, i) => (
          <text key={`skill-line-${i}`} fg={palette.text}>
            {line.length === 0 ? ' ' : line}
          </text>
        ))}
      </scrollbox>
      <box
        style={{
          flexDirection: 'row',
          backgroundColor: palette.backgroundElement,
          marginTop: 1
        }}
      >
        {actions.map((action, i) => (
          <box
            key={`learn-action-${action}`}
            style={{
              flexDirection: 'row',
              backgroundColor: i === actionIdx ? palette.primary : palette.backgroundElement,
              marginRight: 1
            }}
          >
            <text fg={i === actionIdx ? palette.background : palette.text}>
              {` ${action === 'save' ? 'Save' : action === 'change' ? 'Request change' : 'Reject'} `}
            </text>
          </box>
        ))}
      </box>
      <text fg={palette.textMuted}>
        ↑/↓ scroll body · Tab/←/→ action · s/c/r shortcuts · ↵ choose · Esc close
      </text>
    </box>
  );
};

type ProviderKindLabel = 'openrouter' | 'anthropic' | 'openai-codex' | 'local' | 'unknown';

const withSelectedDefaultModel = (
  cfg: AtlasConfig,
  modelId: string,
  kind: ProviderKindLabel
): AtlasConfig => ({
  ...cfg,
  defaultModel: modelId,
  ...(kind === 'openrouter' || kind === 'anthropic' || kind === 'local'
    ? { defaultProvider: kind }
    : {})
});

/**
 * Resolve the provider that should run a given model id. Mirrors
 * `providerKindFor` in App.tsx — first the live catalog, then a
 * shape heuristic. Critical: without this the OpenTUI variant would
 * keep sending OpenAI / OpenRouter ids to whatever provider happened
 * to be active at boot (often Anthropic via Claude Code OAuth) and
 * 404 on the first turn.
 */
const providerKindFor = (
  modelId: string,
  catalog: readonly ModelInfo[] | undefined
): ProviderKindLabel => {
  const hit = catalog?.find((m) => m.id === modelId);
  if (hit) return hit.provider;
  if (modelId.includes('/')) return 'openrouter';
  const m = modelId.toLowerCase();
  if (/^claude/.test(m)) return 'anthropic';
  if (/^(gpt-|codex-|o[1-9])/.test(m)) return 'openai-codex';
  return 'unknown';
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
    case 'local':
      return 'Local (Ollama / LM Studio)';
    case 'unknown':
      return 'unknown';
  }
};

// Default context window for the right-sidebar token chip when the
// active model isn't recognised. 200k matches Claude Sonnet 4.5 — the
// Atlas default. The Ink TUI uses the same fallback.
const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Per-model context window resolver. Mirrors `contextWindowFor` in
 * App.tsx: prefer the live catalog (so multi-key users get the
 * correct chip for whichever provider exposes the model), fall back
 * to id-shape heuristics for offline / custom ids.
 */
const contextWindowFor = (
  modelId: string,
  catalog: readonly ModelInfo[] | undefined
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
  return DEFAULT_CONTEXT_WINDOW;
};

/**
 * Strip every `<atlas:question>...</atlas:question>` block from a
 * string. Mirrors `stripInteractionBlocks` in App.tsx — used to keep
 * the protocol noise out of the transcript and out of message
 * history (so the next turn doesn't quote a stale question back at
 * the model).
 */
const stripInteractionBlocks = (s: string): string =>
  s.replace(/<atlas:question>[\s\S]*?<\/atlas:question>/g, '').trim();

/**
 * Strip *complete* interaction blocks AND hide an *in-progress*
 * (still-streaming) opener so the live transcript stays free of raw
 * protocol noise while the model is mid-question. Same contract as
 * App.tsx's `renderVisibleAssistant`.
 */
const renderVisibleAssistant = (buf: string): string => {
  const stripped = buf.replace(
    /<atlas:question>[\s\S]*?<\/atlas:question>/g,
    ''
  );
  const open = stripped.indexOf('<atlas:question>');
  return (open >= 0 ? stripped.slice(0, open) : stripped).trimEnd();
};

/** Build the runtime reasoning option from the user's `/thinking` pick. */
const buildReasoning = (
  level: ThinkingLevel
): ReasoningOptions | undefined => {
  if (level === 'off') return undefined;
  if (level === 'xhigh') return { effort: 'high' as ReasoningEffort, maxTokens: 32_000 };
  return { effort: level as ReasoningEffort };
};

// Minimum width before we mount the right-side activity sidebar. Below
// this the chat column gets the full row. Mirrors the Ink TUI cutoff.
const SIDEBAR_MIN_COLS = 110;

const THINKING_OPTIONS_ALL: readonly PickerOption[] = [
  { value: 'off', label: 'off', description: 'no thinking budget' },
  { value: 'low', label: 'low', description: 'fast — minimal reasoning' },
  { value: 'medium', label: 'medium', description: 'balanced (default)' },
  { value: 'high', label: 'high', description: 'deeper reasoning' },
  { value: 'xhigh', label: 'xhigh', description: 'maximum budget' }
];

const MODE_OPTIONS: readonly PickerOption[] = [
  { value: 'plan', label: 'plan', description: 'read-only — no tool side effects' },
  { value: 'build', label: 'build', description: 'ask before side-effect tools' },
  {
    value: 'autopilot',
    label: 'autopilot',
    description: 'unattended — side-effect tools auto-approved'
  }
];

// Static fallback list — used when no live model catalog is available.
// Augmented with anything the user has configured under
// `providers.openrouter.customModels` and the active default + fallbacks.
const STATIC_MODELS: readonly string[] = [
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-opus-4-1',
  'openai/gpt-4o',
  'openai/o4-mini',
  'google/gemini-2.0-flash',
  'google/gemini-2.5-pro',
  'meta-llama/llama-3.3-70b-instruct',
  'qwen/qwen3-coder'
];

const PROVIDER_TAG: Record<string, string> = {
  openrouter: 'OR',
  anthropic: 'AN',
  'openai-codex': 'CDX',
  local: 'LCL'
};

interface SlashCommand {
  readonly name: string;
  readonly summary: string;
}

interface McpCatalogEntry {
  readonly id: string;
  readonly pricing: 'free' | 'byo' | 'paid' | 'freemium';
  readonly transport: 'stdio' | 'http';
  readonly summary: string;
  readonly url?: string;
  readonly envKey?: string;
  readonly envPlaceholder?: string;
  readonly docs?: string;
}

// Curated MCP catalog mirroring the Ink TUI's `/config → MCP server`
// add wizard. Keep in sync with packages/cli/src/tui/App.tsx (the
// MCP_CATALOG constant near `mcpCatalog`). When you add an entry
// here, mirror it in Ink so both variants surface the same set.
const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: 'filesystem',
    pricing: 'free',
    transport: 'stdio',
    summary: 'Read/write files in a sandboxed root directory.',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem'
  },
  {
    id: 'github',
    pricing: 'byo',
    transport: 'stdio',
    summary: 'GitHub API: issues, PRs, repos, code search.',
    envKey: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    envPlaceholder: 'ghp_…',
    docs: 'https://github.com/github/github-mcp-server'
  },
  {
    id: 'higgsfield',
    pricing: 'paid',
    transport: 'http',
    url: 'https://higgsfield.ai/mcp',
    summary: 'Higgsfield — image + video generation (hosted).',
    envKey: 'HIGGSFIELD_API_KEY',
    envPlaceholder: 'hgs_…',
    docs: 'https://higgsfield.ai/mcp'
  },
  {
    id: 'figma',
    pricing: 'freemium',
    transport: 'http',
    url: 'https://mcp.figma.com/mcp',
    summary: 'Figma — read frames, components, styles (hosted).',
    envKey: 'FIGMA_API_TOKEN',
    envPlaceholder: 'figd_…',
    docs: 'https://github.com/figma/mcp-server-guide'
  },
  {
    id: 'memory',
    pricing: 'free',
    transport: 'stdio',
    summary: 'Built-in long-term memory store (Atlas).'
  }
];

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'help', summary: 'show this list' },
  { name: 'clear', summary: 'clear the conversation' },
  { name: 'history', summary: 'print the message history' },
  { name: 'model', summary: 'switch model (no arg → open picker)' },
  { name: 'restart', summary: 'force-refresh the live model catalog' },
  { name: 'agent', summary: 'switch agent (or list)' },
  { name: 'agents', summary: 'list installed agents and their bound models' },
  { name: 'mode', summary: 'set permission mode (plan|build|autopilot)' },
  { name: 'thinking', summary: 'set reasoning effort (model-aware)' },
  { name: 'config', summary: 'open the config menu (API keys, OAuth, integrations)' },
  { name: 'mcps', summary: 'list / add / enable / disable MCP servers' },
  { name: 'sessions', summary: 'list, resume, rename, or bulk-delete saved sessions' },
  { name: 'resume', summary: 'resume a session by id' },
  { name: 'compact', summary: 'auto-compaction status' },
  { name: 'learn', summary: 'distill current turn into a skill (use `/learn force` to override the heuristic)' },
  { name: 'skills', summary: 'list / enable / disable skills' },
  { name: 'next', summary: 'ask Atlas which command to run next' },
  { name: 'onboard', summary: 'brownfield onboarding wizard' },
  { name: 'tools', summary: 'list registered tools' },
  { name: 'status', summary: 'show current workflow phase / active task' },
  { name: 'back', summary: 'rewind the workflow to an earlier phase' },
  { name: 'skip', summary: 'jump forward to the next workflow phase' },
  { name: 'abort', summary: 'abandon the current task (state preserved)' },
  { name: 'quit', summary: 'leave atlas' },
  { name: 'exit', summary: 'leave atlas' }
];

// Slash commands not yet ported — surfaced with a clear message instead
// of failing silently. Mirrors the Ink TUI's behavior for the same
// commands once Atlas was upgraded but the OpenTUI variant trailed.
//
// Round 5 (May 2026): emptied. Every slash command in SLASH_COMMANDS
// now has a real handler. The set is kept (empty) so the dispatch
// site stays generic — adding a future stub-only command is a
// one-liner instead of restructuring the switch.
const NOT_YET_PORTED = new Set<string>([]);

const LOCAL_TOOL_MODE_ORDER: readonly LocalProviderToolMode[] = ['lite', 'hybrid', 'full'];
const ATLAS_POWER_MODE_ORDER: readonly AtlasPowerMode[] = ['full', 'smart'];

const isLocalProviderToolMode = (value: string): value is LocalProviderToolMode =>
  LOCAL_TOOL_MODE_ORDER.some((mode) => mode === value);

const isAtlasPowerMode = (value: string): value is AtlasPowerMode =>
  ATLAS_POWER_MODE_ORDER.some((mode) => mode === value);

const promptCacheLabel = (model: ModelInfo | undefined): string => {
  switch (model?.promptCache) {
    case 'supported':
      return 'cache: yes (cheaper)';
    case 'unsupported':
      return 'cache: no';
    case 'unknown':
    default:
      return 'cache: unknown';
  }
};

const providerTagFor = (
  model: string,
  catalog: readonly ModelInfo[] | undefined
): string => {
  // Prefer the live catalog — same heuristic the Ink TUI uses, so
  // multi-provider users see the correct backend chip even for
  // ambiguous ids like `gpt-5` (OpenRouter vs Codex OAuth).
  const hit = catalog?.find((m) => m.id === model);
  if (hit) return PROVIDER_TAG[hit.provider] ?? 'OR';
  if (model.includes('/')) return 'OR';
  const m = model.toLowerCase();
  if (/^claude/.test(m)) return 'AN';
  if (/^(gpt-|codex-|o[1-9])/.test(m)) return 'CDX';
  // Local model id heuristic: `family:tag` (e.g. qwen2.5-coder:1.5b)
  // — ollama-style ids never contain `/`.
  if (/:/.test(model)) return 'LCL';
  return 'OR';
};

/**
 * Persist a single API key into ~/.atlas/config.yaml. Returns the
 * resolved path on success or a human-readable error string on
 * failure. Handles the "first run \u2014 no config file yet" case by
 * synthesising a sensible default config so the user can configure
 * Atlas without any prior `atlas init` step.
 */
const saveProviderKey = async (
  target: 'openrouter' | 'anthropic',
  key: string,
  current: AtlasConfig | undefined
): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
  const trimmed = key.trim();
  if (trimmed.length < 8) return { ok: false, error: 'key looks too short' };
  // Comma-separated rotation: first id = primary, rest = fallback rotated on 401/429.
  const parts = trimmed.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const primary = parts[0] ?? trimmed;
  const fallbacks = parts.slice(1);
  const baseCfg: AtlasConfig = current ?? {
    defaultProvider: target,
    defaultModel: target === 'anthropic' ? 'claude-sonnet-4-5' : 'anthropic/claude-sonnet-4-5',
    fallbackModels: [],
    atlasMode: 'full',
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
      },
      local: {
        baseUrl: 'http://localhost:11434/v1',
        headers: {},
        autoDetect: true,
        customModels: [],
        toolMode: 'lite',
        liteMode: true,
        requestTimeoutMs: 300_000
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
      discoverGuardrails: true,
      progressTracker: true,
      extraDeniedPaths: [],
      extraDeniedCommands: []
    },
    ship: { autoResolve: 'abort', promptOnConflict: true }
  };
  const next: AtlasConfig =
    target === 'openrouter'
      ? {
          ...baseCfg,
          providers: {
            ...baseCfg.providers,
            openrouter: {
              ...baseCfg.providers.openrouter,
              apiKey: primary,
              apiKeys: fallbacks
            }
          }
        }
      : {
          ...baseCfg,
          providers: {
            ...baseCfg.providers,
            anthropic: {
              ...baseCfg.providers.anthropic,
              apiKey: primary,
              apiKeys: fallbacks
            }
          }
        };
  const saved = await saveConfig(next);
  if (!saved.ok) return { ok: false, error: saved.error.message };
  return { ok: true, path: saved.value.path };
};

/**
 * Strip the saved API key (and any rotation list) for `target` from
 * the on-disk config and return the new file path. Used by /config →
 * "remove key" so the user can revoke a leaked key from inside the
 * TUI without editing ~/.atlas/config.yaml by hand. Mirrors the Ink
 * TUI's disconnect flow.
 */
const removeProviderKey = async (
  target: 'openrouter' | 'anthropic',
  current: AtlasConfig | undefined
): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
  if (!current) return { ok: false, error: 'no config to modify' };
  const next: AtlasConfig =
    target === 'openrouter'
      ? {
          ...current,
          providers: {
            ...current.providers,
            openrouter: {
              ...current.providers.openrouter,
              apiKey: undefined,
              apiKeys: []
            }
          }
        }
      : {
          ...current,
          providers: {
            ...current.providers,
            anthropic: {
              ...current.providers.anthropic,
              apiKey: undefined,
              apiKeys: []
            }
          }
        };
  const saved = await saveConfig(next);
  if (!saved.ok) return { ok: false, error: saved.error.message };
  return { ok: true, path: saved.value.path };
};

export const OpenTuiApp = (props: OpenTuiAppProps) => {
  const { width, height } = useTerminalDimensions();
  const [input, setInput] = useState<string>('');
  const [transcript, setTranscript] = useState<readonly TranscriptItem[]>(() => {
    // Hydrate visible chat from the resumed session's messages so the
    // user lands inside their previous conversation, not a blank
    // splash. Tool/reasoning rounds are not replayed (we never
    // persisted those) — only the user/assistant turns survive.
    // Skip system + tool roles (they have no place in the visible
    // transcript) and drop assistant turns that strip down to empty
    // — those were turns whose entire body was an `<atlas:question>`
    // block, and rendering them as a bare "ATLAS" header with no
    // text is the empty-ghost-row bug users see at the bottom of
    // resumed sessions.
    const seed = props.initialSession?.messages ?? [];
    return seed.flatMap<TranscriptItem>((m, i) => {
      if (m.role !== 'user' && m.role !== 'assistant') return [];
      const raw = typeof m.content === 'string' ? m.content : '';
      const text =
        m.role === 'assistant' ? renderVisibleAssistant(raw) : raw;
      if (text.length === 0) return [];
      return [
        {
          kind: m.role === 'user' ? ('user' as const) : ('assistant' as const),
          text,
          key: `seed_${i}`
        }
      ];
    });
  });
  const [streaming, setStreaming] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(props.setupError ?? null);
  const [tokensUsed, setTokensUsed] = useState<number>(() =>
    estimateContextTokens(props.initialSession?.messages ?? [])
  );
  const [mode, setMode] = useState<Mode>('build');
  const [thinking, setThinking] = useState<ThinkingEffort>('medium');
  const [overlay, setOverlay] = useState<OverlayKind | null>(null);
  // Server name selected in `mcps-manage` — used by the per-row
  // action overlay (`mcps-actions`) to know which entry to
  // enable/disable/remove.
  const [selectedMcp, setSelectedMcp] = useState<string | null>(null);
  // Active /config -> MCP add wizard. Tracks the suggestion being
  // installed, which env var we're collecting next, and the values
  // accumulated so far. Reset whenever the wizard closes.
  const [mcpAddState, setMcpAddState] = useState<{
    readonly id: string;
    readonly envIndex: number;
    readonly collected: Record<string, string>;
  } | null>(null);
  // Session id selected in `sessions-list` — used by the per-row
  // action overlay (`sessions-actions`) to know which session to
  // resume/rename/delete.
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [markedSessionIds, setMarkedSessionIds] = useState<readonly string[]>([]);
  const [pendingDeleteSessionIds, setPendingDeleteSessionIds] = useState<readonly string[]>([]);
  // Active session id + title shown in the header. Initially seeded
  // from `props.initialSession` (when atlas was launched with
  // `--resume`/`--continue`); updated on resume from the modal and
  // on rename via the modal's edit action.
  const [sessionId, setSessionId] = useState<string | null>(
    props.initialSession?.id ?? null
  );
  const [sessionTitle, setSessionTitle] = useState<string | null>(
    props.initialSession?.title ?? null
  );
  // Mutable mirror of the active session record. Used for per-turn
  // writes (we mutate `messages` in place and fire-and-forget the
  // disk write) and to know whether the next user turn should lazily
  // create a fresh session record on disk. Mirrors Ink's
  // `sessionRef` pattern (App.tsx:615).
  const sessionRef = useRef<SessionRecord | null>(props.initialSession ?? null);
  // Draft string the user is typing in the rename overlay.
  const [renameDraft, setRenameDraft] = useState<string>('');
  // Cached session listing for the modal. Refreshed on overlay open
  // and after every mutating action.
  const [sessionList, setSessionList] = useState<
    readonly { id: string; updatedAt?: string; title?: string }[]
  >([]);
  // Onboarding wizard draft — populated by `estimateOnboardCost` and
  // mutated step-by-step. Mirrors Ink's `OnboardDraft`.
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
      readonly map?: string;
      readonly architecture?: string;
      readonly onboarding?: string;
    };
    /**
     * User-confirmed list of existing docs to feed into the
     * onboarding prompt as "READ FIRST, update in place" inputs.
     * Empty when the user opted to start fresh (or when no docs
     * were found in the repo).
     */
    readonly reuseDocs?: readonly OnboardingDocCandidate[];
  }
  const [onboardDraft, setOnboardDraft] = useState<OnboardDraft | null>(null);
  const [onboardDocCandidates, setOnboardDocCandidates] = useState<
    readonly OnboardingDocCandidate[]
  >([]);
  const [onboardTarget, setOnboardTarget] = useState<
    'same' | 'cheap' | 'fallback' | 'map' | 'arch' | 'onboard' | null
  >(null);
  const [onboardStatus, setOnboardStatus] = useState<string>('');
  // Tools manage modal — cached catalog status. Refreshed each time
  // the overlay opens.
  const [toolStatusList, setToolStatusList] = useState<
    readonly ResolvedToolStatus[]
  >([]);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [activeAgentName, setActiveAgentName] = useState<string | null>(
    props.initialAgentName ?? null
  );
  const [activeModel, setActiveModel] = useState<string>(props.defaultModel);
  const [activeAtlasMode, setActiveAtlasMode] = useState<AtlasPowerMode>(
    props.config?.atlasMode ?? 'full'
  );
  // Live provider runtime — switched whenever the user picks a model
  // from a different vendor (e.g. /model gpt-5.5 with Codex OAuth
  // configured swaps from Anthropic to Codex). Without this state
  // every turn would route through `props.provider`, the boot-time
  // default, regardless of what the user picked.
  const [activeProvider, setActiveProvider] = useState<Provider | null>(
    props.provider
  );
  const [activeProviderKind, setActiveProviderKind] =
    useState<ProviderKindLabel>(() =>
      providerKindFor(props.defaultModel, props.modelCatalog)
    );
  /**
   * Persistent conversation history for the current session. Each
   * call to `submit()` appends the user message; on `turn_end` we
   * append the model's committed `assistantMessage`. Sent verbatim
   * to `runAgentLoop` so the model sees prior turns — without this
   * Atlas would feel amnesiac (every reply ignores the previous
   * exchange). Mirrors `messagesRef` in App.tsx.
   */
  const messagesRef = useRef<Message[]>(
    // Seed with the resumed session's prior messages on mount so the
    // model sees the full conversation history. Empty array on a
    // fresh launch.
    props.initialSession?.messages ? [...props.initialSession.messages] : []
  );
  const [recentTools, setRecentTools] = useState<readonly SidebarToolEvent[]>([]);
  // Live mirror of `props.toolContext.todoStore`. The store itself is
  // mutated by the agent through the `todo` tool; we copy its state
  // into React state on mount + after each `todo` tool_call_done so
  // the sidebar can render a checklist instead of a tool-name tail.
  const [todos, setTodos] = useState<readonly SidebarTodo[]>(() => {
    const store = props.toolContext.todoStore;
    if (!store) return [];
    return store.read().map((t) => ({ id: t.id, content: t.content, status: t.status }));
  });
  const refreshTodos = useCallback((): void => {
    const store = props.toolContext.todoStore;
    if (!store) return;
    setTodos(
      store.read().map((t) => ({ id: t.id, content: t.content, status: t.status }))
    );
  }, [props.toolContext.todoStore]);
  const [thinkingLine, setThinkingLine] = useState<string | null>(null);
  const [toolCount, setToolCount] = useState<number>(0);
  /**
   * Live "current tool" — the one tool that's executing right now,
   * if any. Rendered as an ephemeral row right above the composer
   * (the way VS Code shows "Running cell…" / "Searching files…")
   * and cleared on `tool_call_done` so it never accumulates.
   */
  const [activeTool, setActiveTool] = useState<{
    name: string;
    startedAt: number;
  } | null>(null);
  /**
   * Live VS-Code-style turn timeline — one row per "phase" of the
   * current turn (Thinking…, Reading foo.ts, Edited bar.ts, …).
   * Reset at the start of every `submit()`. Frozen into the
   * transcript as a `kind:'timeline'` item on `done`. Drives the
   * activity strip rendered just above the composer.
   */
  const [currentTurnSteps, setCurrentTurnSteps] = useState<readonly TurnStep[]>([]);
  /**
   * Key of the live timeline transcript item that's pushed at
   * submit-time so the activity card renders ABOVE the assistant
   * reply (matching the VS Code chat order: user → activity →
   * answer). Cleared between turns.
   */
  const liveTimelineKey = useRef<string | null>(null);
  /**
   * Typewriter reveal — total chars from `thinkingLine` (the full
   * accumulated reasoning buffer) currently visible on screen.
   * Advances ~6 chars every 40 ms while a thinking step is open,
   * which roughly matches the VS Code Copilot reveal speed and
   * stays comfortably readable instead of dumping the whole stream
   * the instant the provider sends it.
   */
  const [thinkingRevealedLines, setThinkingRevealedLines] = useState<number>(0);
  // Mirror `currentTurnSteps` into the live timeline transcript
  // item so the activity card visible ABOVE the assistant reply
  // updates as events stream in. Skips when there's no live key
  // (between turns) — the frozen card is owned by the transcript
  // directly at that point.
  useEffect(() => {
    const k = liveTimelineKey.current;
    if (!k) return;
    setTranscript((prev) =>
      prev.map((it) =>
        it.key === k && it.kind === 'timeline'
          ? { ...it, steps: currentTurnSteps }
          : it
      )
    );
  }, [currentTurnSteps]);
  // Re-render every 250 ms while a tool is running so the live
  // elapsed timer ticks. Cheap because we only schedule the timer
  // when there's actually a tool in flight.
  const [, setTickNow] = useState<number>(0);
  useEffect(() => {
    if (!activeTool) return;
    const id = setInterval(() => setTickNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [activeTool]);
  // Typewriter — line-oriented reveal. Reveal one whole row of
  // reasoning every ~140 ms (≈ 7 lines/sec) so the panel feels
  // like VS Code Copilot's "thinking" stream: each thought lands
  // as a discrete row instead of crawling in character by
  // character. Slow enough to actually read, fast enough that it
  // never feels stalled.
  const thinkingBufferLines = useMemo(
    () => (thinkingLine ? thinkingLine.split('\n').length : 0),
    [thinkingLine]
  );
  useEffect(() => {
    if (thinkingBufferLines === 0) return;
    if (thinkingRevealedLines >= thinkingBufferLines) return;
    const id = setInterval(() => {
      setThinkingRevealedLines((prev) =>
        prev >= thinkingBufferLines ? prev : prev + 1
      );
    }, 140);
    return () => clearInterval(id);
  }, [thinkingBufferLines, thinkingRevealedLines]);
  // /config overlay state — transient panels (info text shown in the
  // 'config-info' overlay; key entry error message under the masked
  // input). Reset whenever the overlay closes.
  const [infoOverlay, setInfoOverlay] = useState<{
    title: string;
    body: string;
    tone?: 'info' | 'warn' | 'error';
  } | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  // Slash autocomplete cursor — index into the *filtered* match list.
  // Resets to 0 every time the input changes. The list itself is
  // computed below as `slashSuggestions`.
  const [slashCursor, setSlashCursor] = useState<number>(0);
  // Workflow phase task — restored on launch, mutated by /back, /skip,
  // /abort. Mirrors the Ink TUI's `activeTask` state.
  const [activeTask, setActiveTask] = useState<TaskState | null>(
    props.initialActiveTask ?? null
  );
  // Track the active task in a ref too so the background phase
  // classifier in submit() reads the latest value without depending
  // on React's render cycle. Mirrors `activeTaskRef` in App.tsx.
  const activeTaskRef = useRef<TaskState | null>(activeTask);
  useEffect(() => {
    activeTaskRef.current = activeTask;
  }, [activeTask]);
  // Structured-question protocol — when the model emits an
  // `<atlas:question>` block we extract it, hide the raw block from
  // the transcript, and pop a picker overlay so the user picks one
  // of the suggested options (or types freeform). Mirrors the Ink
  // TUI's option-picker / option-freeform overlay pair.
  const [interactionRequest, setInteractionRequest] =
    useState<InteractionRequest | null>(null);
  // Cumulative spend for this session (USD). Computed from the
  // model catalog's pricing data after each `done` event.
  const [costUsd, setCostUsd] = useState<number>(0);
  // Cumulative provider token usage for this session. Separate from
  // `tokensUsed`, which is the live context-window estimate and drops
  // after compaction.
  const [sessionTokensUsed, setSessionTokensUsed] = useState<number>(0);
  // Ship-conflict config — fed straight into toolContext.shipDefaults
  // so `ship_apply` doesn't crash with an unhandled prompt and the
  // user-configured strategy actually applies. The OpenTUI variant
  // doesn't pop the conflict overlay yet (it falls back to the
  // configured strategy automatically), so the prompt callback just
  // returns the default. This is still a parity improvement —
  // before, ship_apply would call into a missing `shipResolveAsk`
  // and the loop would block.
  const shipAutoResolveRef = useRef<'abort' | 'ours' | 'theirs' | 'ai'>(
    props.config?.ship?.autoResolve ?? 'abort'
  );
  const shipPromptOnConflictRef = useRef<boolean>(
    props.config?.ship?.promptOnConflict ?? false
  );
  // Live ship-conflict overlay state. When ship_apply hits a
  // conflict and shipPromptOnConflictRef is true, we set this and
  // surface the strategy picker; the resolver ref holds the pending
  // promise so the user's pick unblocks the agent loop.
  const [shipConflict, setShipConflict] = useState<{
    readonly base: string;
    readonly branch: string;
    readonly conflictFiles: readonly string[];
    readonly selected: 'abort' | 'ours' | 'theirs' | 'ai';
    readonly persist: boolean;
  } | null>(null);
  const shipResolveResolverRef = useRef<
    ((v: { strategy: 'abort' | 'ours' | 'theirs' | 'ai'; persist: boolean } | null) => void) | null
  >(null);
  // Auto-learn starts on; `/learn off` disables post-turn reflection.
  const learnEnabledRef = useRef<boolean>(DEFAULT_AUTO_LEARN_ENABLED);
  // Per-turn telemetry that the auto-learn heuristic reads after
  // each `done` event. Reset on submit, mutated by tool_call_done +
  // done. Mirrors App.tsx { turnRoundsRef, turnToolErrorsRef,
  // lastUserMessageRef }.
  const turnRoundsRef = useRef<number>(0);
  const turnToolErrorsRef = useRef<number>(0);
  const lastUserMessageRef = useRef<string>('');
  // Reflection sub-call abort handle — Esc on the learn-confirm
  // overlay aborts the in-flight stream.
  const reflectAbortRef = useRef<AbortController | null>(null);
  const [learnConfirm, setLearnConfirm] = useState<LearnConfirmState | null>(null);
  const [toolApproval, setToolApproval] = useState<ToolApprovalState | null>(null);
  const toolApprovalResolverRef = useRef<((decision: ApprovalDecision) => void) | null>(null);
  // Auto-compaction settings (loaded from config, mutated by /compact).
  const compactEnabledRef = useRef<boolean>(
    props.config?.compaction?.enabled ?? true
  );
  const compactThresholdRef = useRef<number>(
    props.config?.compaction?.threshold ?? 0.75
  );
  const compactContextTokensRef = useRef<number>(
    props.config?.compaction?.contextTokens ?? 200_000
  );
  const compactModelRef = useRef<string | null>(
    props.config?.compaction?.model ?? null
  );
  // Per-agent model bindings — `/agent <name> <model>` records the
  // pairing so future routing-only flips between agents stay on the
  // model the user picked for that agent. Mirrors Ink's
  // `agentModels` Map<string,string>.
  const [agentModels, setAgentModels] = useState<Map<string, string>>(
    () => new Map()
  );
  // Live-refreshed model catalog override (set by `/restart models`).
  // When non-null it replaces props.modelCatalog in modelEntries.
  const [catalogOverride, setCatalogOverride] = useState<
    readonly ModelInfo[] | null
  >(null);
  // Anthropic OAuth health: when the user signed into Claude Code
  // and the token has since expired (and there's no fallback API
  // key), the model picker hides Anthropic models and surfaces a
  // refresh hint instead. Mirrors what the Ink TUI's setup menu
  // shows when the user opens the Claude Code panel.
  const [anthropicOAuthExpired, setAnthropicOAuthExpired] =
    useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    const hasApiKey = Boolean(
      props.config?.providers.anthropic.apiKey
    );
    if (hasApiKey) {
      setAnthropicOAuthExpired(false);
      return;
    }
    void (async (): Promise<void> => {
      const r = await loadClaudeCodeCredentials({});
      if (cancelled) return;
      if (!r.ok) {
        // No creds → not "expired", just unconfigured. We use the
        // expired flag specifically for the *was-signed-in-but-stale*
        // case so we can show the right hint.
        setAnthropicOAuthExpired(false);
        return;
      }
      const exp = r.value.expiresAt;
      const isExpired =
        typeof exp === 'number' && exp > 0 && exp < Date.now();
      setAnthropicOAuthExpired(isExpired);
    })();
    return (): void => {
      cancelled = true;
    };
  }, [props.config]);
  const transcriptKey = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);
  const composerRef = useRef<TextareaRenderable | null>(null);
  // Ctrl-D twice within this window confirms exit. Resets after
  // the window expires so an accidental single Ctrl-D doesn't arm
  // the next one minutes later.
  const exitArmedAt = useRef<number>(0);
  // Ref to the chat scrollbox. PgUp / PgDn / Home / End hotkeys
  // call its `scrollBy` method directly because the textarea steals
  // raw key focus and the scrollbox's built-in handlers never fire.
  const scrollboxRef = useRef<{
    scrollBy: (delta: number, unit: 'absolute' | 'viewport' | 'content') => void;
  } | null>(null);

  const activeAgent = useMemo<Agent | null>(() => {
    const list = props.agents.list();
    if (list.length === 0) return null;
    if (activeAgentName) {
      const a = props.agents.get(activeAgentName);
      if (a) return a;
    }
    return props.agents.get('atlas') ?? list[0] ?? null;
  }, [props.agents, activeAgentName]);

  useEffect(() => {
    setActiveAtlasMode(props.config?.atlasMode ?? 'full');
  }, [props.config?.atlasMode]);

  // Switchable agents — mirrors the Ink TUI rule (App.tsx § switchableAgents):
  // the orchestrator (`atlas`) plus every user-added (non-framework) agent.
  // Framework specialists (Athena/Prometheus/…) are routed to by `atlas`,
  // never picked manually — so on a default install only `atlas` is
  // switchable and Tab is a no-op.
  const switchableAgents = useMemo<readonly Agent[]>(() => {
    return props.agents
      .list()
      .filter((a) => !isFrameworkAgent(a) || a.name === 'atlas');
  }, [props.agents]);

  const agentOptions = useMemo<readonly PickerOption[]>(() => {
    return switchableAgents.map((a) => ({
      value: a.name,
      label: a.name,
      description: a.role ?? ''
    }));
  }, [switchableAgents]);

  // Thinking levels filtered to what the active model actually supports.
  // `thinkingLevelsFor` walks the live catalog first, then falls back to
  // id-shape heuristics — same source the Ink TUI consumes.
  const thinkingOptions = useMemo<readonly PickerOption[]>(() => {
    const allowed = new Set<ThinkingLevel>(
      thinkingLevelsFor(activeModel, props.modelCatalog ?? [])
    );
    return THINKING_OPTIONS_ALL.filter((o) => allowed.has(o.value as ThinkingLevel));
  }, [activeModel, props.modelCatalog]);

  useEffect(() => {
    setThinking((prev) =>
      thinkingOptions.some((o) => o.value === prev)
        ? prev
        : ((thinkingOptions[0]?.value ?? 'off') as ThinkingEffort)
    );
  }, [thinkingOptions]);

  // Grouped model entries \u2014 mirrors the Ink TUI's `(() => { … })()`
  // grouped picker (App.tsx, model overlay). Sections in fixed order:
  // Anthropic, OpenAI (ChatGPT/Codex), then OpenRouter \u2014 with a
  // "\u2605 Popular" sub-header inside OR seeded by curated patterns. Each
  // section only appears when its provider runtime is active or when
  // there's at least one entry to show. Entries surface alongside the
  // provider's context window in the description column.
  const modelEntries = useMemo<readonly GroupedPickerEntry[]>(() => {
    const catalog = catalogOverride ?? props.modelCatalog ?? [];
    const providers = props.providers ?? {};
    const customModels = props.config?.providers.openrouter.customModels ?? [];
    const seedOR = [
      ...(props.availableModels ?? []),
      ...(props.fallbackModels ?? []),
      props.defaultModel
    ].filter((id): id is string => typeof id === 'string' && id.includes('/'));

    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of catalog) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }

    const groupOrder: readonly ('local' | 'anthropic' | 'openai-codex' | 'openrouter')[] = [
      'local',
      'anthropic',
      'openai-codex',
      'openrouter'
    ];
    const groupLabel = (k: string): string => {
      if (k === 'local') return '\u2500\u2500 Local (Ollama / LM Studio) \u2500\u2500';
      if (k === 'anthropic') return '\u2500\u2500 Anthropic \u2500\u2500';
      if (k === 'openai-codex') return '\u2500\u2500 OpenAI (ChatGPT / Codex) \u2500\u2500';
      if (k === 'openrouter') return '\u2500\u2500 OpenRouter \u2500\u2500';
      return `\u2500\u2500 ${k} \u2500\u2500`;
    };

    const out: GroupedPickerEntry[] = [];
    const seenValues = new Set<string>();
    const ctxLabel = (m: ModelInfo): string => {
      const parts: string[] = [m.provider];
      if (m.contextWindow) parts.push(`${Math.round(m.contextWindow / 1000)}k`);
      parts.push(promptCacheLabel(m));
      return parts.join(' · ');
    };

    for (const grp of groupOrder) {
      // Skip provider sections that have no live runtime AND no
      // catalog/seed entries. Mirrors Ink's `if (!props.providers?.[grp]) continue;`
      // guard but with a softer fallback so users can still see a
      // first-launch model list before any key is configured.
      const hasRuntime = Boolean(providers[grp]);
      const catalogList = byProvider.get(grp) ?? [];
      const customsHere = grp === 'openrouter' ? customModels : [];
      const seedHere = grp === 'openrouter' ? seedOR : [];
      // Anthropic OAuth gate: when the Claude Code token expired AND
      // we don't have a fallback API key, hide the Anthropic models
      // and surface a refresh hint. Continuing to list models we
      // can't actually call would let the user pick a dead one and
      // hit a 401 on the next turn.
      if (
        grp === 'anthropic' &&
        anthropicOAuthExpired &&
        !props.config?.providers.anthropic.apiKey
      ) {
        out.push({
          kind: 'header',
          key: 'hdr_anthropic_expired',
          label: '── Anthropic (OAuth expired) ──'
        });
        out.push({
          kind: 'header',
          key: 'hdr_anthropic_hint',
          label:
            '   ⚠ run `claude` in another terminal to refresh, then /restart models'
        });
        continue;
      }
      if (
        !hasRuntime &&
        catalogList.length === 0 &&
        customsHere.length === 0 &&
        seedHere.length === 0
      ) {
        continue;
      }
      // Tag the section header so the user can see at a glance that
      // picking from this group will 401 — there's no key configured.
      const headerLabel = hasRuntime
        ? groupLabel(grp)
        : `${groupLabel(grp)}  (no key — /config to add)`;
      out.push({ kind: 'header', key: `hdr_${grp}`, label: headerLabel });
      const groupSeen = new Set<string>();
      const addItem = (
        id: string,
        label: string,
        description?: string,
        popular?: boolean
      ): void => {
        if (groupSeen.has(id)) return;
        groupSeen.add(id);
        const key = `${grp}:${id}`;
        if (seenValues.has(key)) return;
        seenValues.add(key);
        out.push({
          kind: 'item',
          key,
          label,
          value: id,
          ...(description ? { description } : {}),
          ...(popular ? { popular: true } : {})
        });
      };

      if (grp === 'openrouter') {
        // \u2605 Popular pins \u2014 curated, matched against catalog ids by
        // pattern so slug drift (kimi-2.6 vs kimi-k2.6) still resolves
        // to the real model and dedups properly.
        const POPULAR: readonly {
          desc: string;
          fallback: string;
          match: (id: string) => boolean;
        }[] = [
          {
            desc: 'Claude Opus 4.7',
            fallback: 'anthropic/claude-opus-4.7',
            match: (id) => /^anthropic\/claude-opus-4[.\-]?7$/i.test(id)
          },
          {
            desc: 'Claude Opus 4.6',
            fallback: 'anthropic/claude-opus-4.6',
            match: (id) => /^anthropic\/claude-opus-4[.\-]?6$/i.test(id)
          },
          {
            desc: 'Claude Sonnet 4.6',
            fallback: 'anthropic/claude-sonnet-4.6',
            match: (id) => /^anthropic\/claude-sonnet-4[.\-]?6$/i.test(id)
          },
          {
            desc: 'Claude Sonnet 4.5',
            fallback: 'anthropic/claude-sonnet-4.5',
            match: (id) => /^anthropic\/claude-sonnet-4[.\-]?5$/i.test(id)
          },
          {
            desc: 'DeepSeek V4',
            fallback: 'deepseek/deepseek-v4',
            match: (id) => /^deepseek\/deepseek-v?4$/i.test(id)
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
        const popularPicks: { id: string; label: string }[] = [];
        const usedIds = new Set<string>();
        for (const pat of POPULAR) {
          const hit = catalogList.find((m) => pat.match(m.id) && !usedIds.has(m.id));
          if (hit) {
            usedIds.add(hit.id);
            // Picker adds its own "★ " prefix on popular rows; we
            // just supply the bare model id as the label.
            popularPicks.push({ id: hit.id, label: hit.id });
          } else if (!catalogList.some((m) => m.id === pat.fallback)) {
            popularPicks.push({ id: pat.fallback, label: pat.fallback });
          }
        }
        if (popularPicks.length > 0) {
          out.push({
            kind: 'header',
            key: 'hdr_or_popular',
            label: '   \u2605 Popular'
          });
          for (const p of popularPicks) {
            const m = catalogList.find((c) => c.id === p.id);
            addItem(p.id, p.label, m ? ctxLabel(m) : 'popular · cache: unknown', true);
          }
        }
        // Rest of OpenRouter \u2014 catalog \u222a seed \u222a customs, alphabetised.
        const rest = new Map<string, { label: string; desc?: string }>();
        for (const m of catalogList) {
          if (groupSeen.has(m.id)) continue;
          rest.set(m.id, {
            label: m.label !== m.id ? `${m.id}` : m.id,
            desc: ctxLabel(m)
          });
        }
        for (const id of seedHere) {
          if (groupSeen.has(id) || rest.has(id)) continue;
          rest.set(id, { label: id, desc: 'seed · cache: unknown' });
        }
        for (const id of customsHere) {
          if (groupSeen.has(id) || rest.has(id)) continue;
          rest.set(id, { label: id, desc: 'custom · cache: unknown' });
        }
        const sorted = [...rest.entries()].sort(([a], [b]) => a.localeCompare(b));
        for (const [id, meta] of sorted) addItem(id, meta.label, meta.desc);
      } else {
        const sorted = [...catalogList].sort((a, b) => a.id.localeCompare(b.id));
        for (const m of sorted) {
          // Use m.label for local so "— not pulled" suffix surfaces.
          const label = grp === 'local' && m.label !== m.id ? m.label : m.id;
          addItem(m.id, label, ctxLabel(m));
        }
      }
    }

    if (out.length === 0) {
      // First-launch / catalog cold \u2014 fall back to a flat seed list so
      // the user can still pick *something*.
      out.push({ kind: 'header', key: 'hdr_seed', label: '\u2500\u2500 Available models \u2500\u2500' });
      const seed = new Set<string>([
        activeModel,
        props.defaultModel,
        ...(props.fallbackModels ?? []),
        ...customModels,
        ...STATIC_MODELS
      ]);
      for (const id of seed) {
        if (!id) continue;
        out.push({
          kind: 'item',
          key: `seed:${id}`,
          label: id,
          value: id,
          description: 'seed · cache: unknown'
        });
      }
    }
    return out;
  }, [
    activeModel,
    props.defaultModel,
    props.fallbackModels,
    props.availableModels,
    props.config,
    props.modelCatalog,
    props.providers,
    catalogOverride,
    anthropicOAuthExpired
  ]);

  // Flat option list \u2014 used by `/model <id>` validation only. The
  // grouped picker is the visual surface; this set lets us check
  // whether `/model <arg>` resolves to a known id.
  const modelOptions = useMemo<readonly PickerOption[]>(() => {
    const out: PickerOption[] = [];
    const seen = new Set<string>();
    for (const e of modelEntries) {
      if (e.kind !== 'item') continue;
      if (seen.has(e.value)) continue;
      seen.add(e.value);
      out.push({
        value: e.value,
        label: e.label,
        ...(e.description ? { description: e.description } : {})
      });
    }
    return out;
  }, [modelEntries]);

  // Slash-command autocomplete — when the input begins with `/` and
  // contains no space yet (i.e. the user is still typing the command
  // name), filter SLASH_COMMANDS by case-insensitive prefix and show
  // the dropdown above the composer. Mirrors the Ink TUI's
  // SlashAutocomplete contract (App.tsx:6908). Returns the empty
  // array when the popup should be hidden.
  const slashSuggestions = useMemo<readonly SlashSuggestion[]>(() => {
    if (overlay !== null) return [];
    if (!input.startsWith('/')) return [];
    if (input.includes(' ')) return [];
    const q = input.slice(1).toLowerCase();
    const matches = SLASH_COMMANDS.filter((c) =>
      c.name.toLowerCase().startsWith(q)
    );
    return matches.map((c) => ({ name: c.name, summary: c.summary }));
  }, [input, overlay]);

  // Reset the autocomplete cursor whenever the suggestion list shape
  // changes (input edited or popup just opened/closed). Keeping it
  // inside an effect avoids the "highlightIndex out of range" flash
  // when the user types a non-matching character.
  useEffect(() => {
    setSlashCursor((prev) => {
      if (slashSuggestions.length === 0) return 0;
      if (prev >= slashSuggestions.length) return 0;
      return prev;
    });
  }, [slashSuggestions]);

  const pushItem = useCallback(
    (kind: TranscriptItem['kind'], text: string, author?: string): void => {
      transcriptKey.current += 1;
      setTranscript((prev) => [
        ...prev,
        {
          key: `t${transcriptKey.current}`,
          kind,
          text,
          ...(author ? { author } : {})
        }
      ]);
    },
    []
  );

  /**
   * Resolve a model id to its provider runtime and switch to it.
   * Returns true on success. Refuses (with a friendly system message)
   * when the matching provider isn't connected — picking GPT-5.5 with
   * only Anthropic configured would otherwise 404 on the next turn.
   */
  const switchToModel = useCallback(
    (id: string, options?: { readonly persist?: boolean }): boolean => {
      const trimmed = id.trim();
      if (trimmed.length === 0) return false;
      const kind = providerKindFor(trimmed, props.modelCatalog);
      const next =
        kind === 'unknown'
          ? undefined
          : props.providers?.[kind];
      if (!next) {
        pushItem(
          'system',
          kind === 'unknown'
            ? `Cannot switch to ${trimmed}: no provider matches this model id (try prefixing with vendor/, e.g. openai/gpt-5).`
            : `Cannot switch to ${trimmed}: ${kind} is not connected. Sign in via /config first, then try again.`
        );
        return false;
      }
      setActiveProvider(next);
      setActiveProviderKind(kind);
      setActiveModel(trimmed);
      if (options?.persist !== false && props.config) {
        const nextCfg = withSelectedDefaultModel(props.config, trimmed, kind);
        void saveConfig(nextCfg).then((r) => {
          if (!r.ok) pushItem('error', `save failed: ${r.error.message}`);
        });
      }
      return true;
    },
    [props.providers, props.modelCatalog, props.config, pushItem]
  );

  const buildApprovalPolicy = useCallback(
    (currentMode: Mode): ApprovalPolicy => {
      if (currentMode === 'plan') return denyAllPolicy;
      if (currentMode === 'autopilot') return allowAllPolicy;
      return {
        decide: (tool, input) =>
          new Promise<ApprovalDecision>((resolve) => {
            toolApprovalResolverRef.current = resolve;
            setToolApproval({
              tool,
              inputPreview: formatApprovalInputPreview(input)
            });
            setOverlay('tool-approval');
          })
      };
    },
    []
  );

  const handleSlash = useCallback(
    (raw: string): boolean => {
      // Returns true if the input was handled (consumed) as a slash
      // command. Falls back to false → caller should send to the model.
      if (!raw.startsWith('/')) return false;
      const parts = raw.slice(1).trim().split(/\s+/);
      const head = parts[0] ?? '';
      const arg = parts.slice(1).join(' ').trim();
      const cmd = head.toLowerCase();
      switch (cmd) {
        case '':
          setOverlay('agent');
          return true;
        case 'help': {
          const lines = SLASH_COMMANDS.map(
            (c) => `/${c.name.padEnd(10)} ${c.summary}`
          ).join('\n');
          pushItem('system', `slash commands\n${lines}`);
          return true;
        }
        case 'clear':
          setTranscript([]);
          // Also drop the model-facing history. Without this, a
          // /clear would only wipe the visible scrollback while the
          // model still saw every prior turn.
          messagesRef.current = [];
          setTokensUsed(0);
          setSessionTokensUsed(0);
          setCostUsd(0);
          return true;
        case 'history': {
          const lines = transcript.map((t) => `[${t.kind}] ${t.text}`).join('\n');
          pushItem('system', lines || '(empty history)');
          return true;
        }
        case 'agents':
        case 'agent':
          if (arg) {
            // `/agent <name> [model]` — switch agents and optionally
            // bind a model. The Ink TUI does fuzzy resolution on the
            // model id; here we accept exact ids only and validate
            // against the catalog (same fall-through warning as
            // `/model`).
            const tokens = arg.split(/\s+/).filter((s) => s.length > 0);
            const nameArg = tokens[0] ?? '';
            const modelArg = tokens.slice(1).join(' ');
            const a = props.agents.get(nameArg);
            if (!a) {
              pushItem('error', `unknown agent: ${nameArg}`);
            } else if (isFrameworkAgent(a) && a.name !== 'atlas') {
              pushItem(
                'error',
                `${a.name} is a framework specialist — routed to by atlas. Not switchable.`
              );
            } else {
              setActiveAgentName(a.name);
              if (modelArg) {
                const known = modelOptions.some((m) => m.value === modelArg);
                // Re-route to the matching provider when the model
                // changes; otherwise the new id will be sent to the
                // old provider and 404.
                const swapped = switchToModel(modelArg);
                if (swapped) {
                  setAgentModels((prev) => {
                    const next = new Map(prev);
                    next.set(a.name, modelArg);
                    return next;
                  });
                  pushItem(
                    'system',
                    known
                      ? `→ agent: ${a.name} with model ${modelArg}`
                      : `→ agent: ${a.name} with model ${modelArg} (not in catalog — hope you typed it right)`
                  );
                }
              } else {
                // No model arg → if a binding exists, restore it.
                const bound = agentModels.get(a.name);
                if (bound && bound !== activeModel) {
                  if (switchToModel(bound)) {
                    pushItem(
                      'system',
                      `→ agent: ${a.name} (restored bound model ${bound})`
                    );
                  }
                } else {
                  pushItem('system', `→ agent: ${a.name}`);
                }
              }
            }
          } else if (cmd === 'agents') {
            // `/agents` (plural) lists installed agents. Active agent
            // is marked with `*`; others with ` `. Bound model (if any)
            // appended after `→`.
            const all = props.agents.list();
            const lines = all
              .map((a) => {
                const active = a.name === activeAgent?.name ? '*' : ' ';
                const tag = isFrameworkAgent(a) && a.name !== 'atlas' ? '[framework]' : '[user]';
                const bound = agentModels.get(a.name);
                const suffix = bound ? `  → ${bound}` : '';
                return `${active} ${tag.padEnd(13)} ${a.name.padEnd(16)} ${a.role ?? ''}${suffix}`.trimEnd();
              })
              .join('\n');
            pushItem('system', `installed agents (${all.length})\n${lines}`);
          } else if (switchableAgents.length <= 1) {
            pushItem(
              'system',
              switchableAgents.length === 1
                ? `only ${switchableAgents[0]?.name ?? 'atlas'} is switchable — install custom agents under ~/.atlas/agents/`
                : 'no agents installed — run `atlas init`'
            );
          } else {
            setOverlay('agent');
          }
          return true;
        case 'model':
          if (arg) {
            // `/model + <id>` — add a custom model id to the OpenRouter
            // catalog (persisted under providers.openrouter.customModels)
            // and switch to it. Mirrors the Ink TUI's model-freeform
            // overlay; lets users name a brand-new OR id without
            // waiting for the catalog cache to refresh.
            if (arg.startsWith('+')) {
              const newId = arg.slice(1).trim();
              if (!newId) {
                pushItem('error', 'usage: /model + <id>   (e.g. /model + openai/gpt-6)');
                return true;
              }
              const baseCfg = props.config;
              if (baseCfg) {
                const customs = baseCfg.providers.openrouter.customModels ?? [];
                const next: AtlasConfig = {
                  ...withSelectedDefaultModel(baseCfg, newId, 'openrouter'),
                  providers: {
                    ...baseCfg.providers,
                    openrouter: {
                      ...baseCfg.providers.openrouter,
                      customModels: customs.includes(newId) ? customs : [...customs, newId]
                    }
                  }
                };
                void saveConfig(next).then((r) => {
                  if (!r.ok) {
                    pushItem('error', `save failed: ${r.error.message}`);
                  }
                });
              }
              if (switchToModel(newId, { persist: false })) {
                pushItem(
                  'system',
                  `→ model: ${newId}  (added to custom catalog — persists across launches)`
                );
              }
              return true;
            }
            // Validate against the catalog — same gate the Ink TUI
            // applies. Unknown ids are still accepted (with a hint)
            // because OpenRouter ships new models faster than the
            // catalog cache refreshes; warn but don't block.
            const known = modelOptions.some((m) => m.value === arg);
            // switchToModel resolves the provider for this model id
            // and refuses with a friendly message when that provider
            // isn't connected. Without this guard the old provider
            // (often Anthropic) would receive an OpenAI / OpenRouter
            // id and 404.
            if (switchToModel(arg)) {
              pushItem(
                'system',
                known
                  ? `→ model: ${arg}`
                  : `→ model: ${arg} (not in catalog — hope you typed it right; tip: /model + ${arg} pins it)`
              );
            }
          } else {
            setOverlay('model');
          }
          return true;
        case 'models':
          // Alias for `/model` with no arg — opens the picker.
          setOverlay('model');
          return true;
        case 'config':
        case 'setup':
          setConfigError(null);
          setOverlay('config');
          return true;
        case 'mcps':
        case 'mcp': {
          const tokens = arg.split(/\s+/).filter((s) => s.length > 0);
          const sub = (tokens[0] ?? '').toLowerCase();
          // /mcps add → open the catalog overlay (the same one /config
          // routes to). Mirrors the Ink TUI's `mcp-add` overlay.
          if (sub === 'add') {
            setOverlay('config-mcp');
            return true;
          }
          // /mcps remove|rm <name> → strip from config.mcp.servers and
          // persist. Same pattern as Ink's removeMcp helper.
          if (sub === 'remove' || sub === 'rm' || sub === 'enable' || sub === 'disable') {
            const target = tokens[1];
            if (!target) {
              pushItem('error', `usage: /mcps ${sub} <name>`);
              return true;
            }
            const baseCfg = props.config;
            if (!baseCfg) {
              pushItem('error', 'no config loaded — cannot persist change');
              return true;
            }
            const servers = baseCfg.mcp?.servers ?? [];
            const idx = servers.findIndex((s) => s.name === target);
            if (idx < 0) {
              pushItem('error', `no such MCP server in config: ${target}`);
              return true;
            }
            let nextServers = servers;
            let msg = '';
            if (sub === 'remove' || sub === 'rm') {
              // Don't allow removing curated default catalog
              // entries — they can be turned off via `disable`.
              if (MCP_CATALOG.some((c) => c.id === target)) {
                pushItem(
                  'error',
                  `'${target}' is a default MCP — disable it instead of removing.`
                );
                return true;
              }
              nextServers = servers.filter((s) => s.name !== target);
              msg = `removed '${target}' from config — restart atlas to drop it from the active session.`;
            } else {
              const enable = sub === 'enable';
              const cur = servers[idx];
              if (!cur) {
                pushItem('error', `no such MCP server: ${target}`);
                return true;
              }
              if (cur.enabled === enable) {
                pushItem('system', `'${target}' is already ${enable ? 'enabled' : 'disabled'}.`);
                return true;
              }
              nextServers = servers.map((s, i) =>
                i === idx ? { ...s, enabled: enable } : s
              );
              msg = `'${target}' ${enable ? 'enabled' : 'disabled'} — restart atlas to apply.`;
            }
            const next: AtlasConfig = {
              ...baseCfg,
              mcp: { ...(baseCfg.mcp ?? { servers: [] }), servers: nextServers }
            };
            void saveConfig(next).then((r) => {
              if (!r.ok) pushItem('error', `save failed: ${r.error.message}`);
              else pushItem('system', msg);
            });
            return true;
          }
          // No sub-command → open the interactive manage overlay
          // (mirrors Ink's `mcp-list` / `mcp-manage` modal). Click a
          // row to enable/disable/remove. Default catalog entries
          // can't be removed, only toggled.
          setSelectedMcp(null);
          setOverlay('mcps-manage');
          return true;
        }
        case 'sessions':
        case 'resume': {
          const store = props.sessionStore;
          if (!store) {
            pushItem('error', 'session store not available');
            return true;
          }
          // `/sessions new` — clear the in-memory transcript and start
          // fresh. Mirrors Ink's `sessionRef.current = null;
          // messagesRef.current = []; setTranscript([])` reset.
          if (arg.toLowerCase() === 'new' && cmd === 'sessions') {
            setTranscript([]);
            messagesRef.current = [];
            setTokensUsed(0);
            setSessionTokensUsed(0);
            setCostUsd(0);
            sessionRef.current = null;
            setSessionId(null);
            setSessionTitle(null);
            transcriptKey.current += 1;
            pushItem('system', '✦ new session — transcript cleared.');
            return true;
          }
          // `/resume <id>` or `/sessions <id>` — load from disk and
          // hydrate the transcript with prior turns.
          const target = arg.trim();
          if (target && target.toLowerCase() !== 'new') {
            void (async (): Promise<void> => {
              try {
                const r = await store.load(target);
                if (!r.ok) {
                  pushItem('error', `resume failed: ${r.error.message}`);
                  return;
                }
                const items = r.value.messages.map((m, i) => ({
                  kind:
                    m.role === 'user'
                      ? ('user' as const)
                      : m.role === 'assistant'
                        ? ('assistant' as const)
                        : ('system' as const),
                  text:
                    m.role === 'assistant'
                      ? renderVisibleAssistant(m.content)
                      : m.content,
                  key: `r${transcriptKey.current}_${i}`
                }));
                setTranscript(items);
                transcriptKey.current += 1;
                messagesRef.current = [...r.value.messages];
                setTokensUsed(estimateContextTokens(messagesRef.current));
                setSessionTokensUsed(0);
                setCostUsd(0);
                sessionRef.current = r.value;
                setSessionId(r.value.id);
                setSessionTitle(r.value.title ?? null);
                pushItem(
                  'system',
                  `✦ resumed session ${target} (${items.length} turns)`
                );
              } catch (e) {
                pushItem('error', `resume failed: ${(e as Error).message}`);
              }
            })();
            return true;
          }
          // Best-effort listing — open the interactive sessions
          // modal. Mirrors Ink's `session-picker` overlay. Click a
          // row to resume / rename / delete.
          void (async () => {
            try {
              const listRes = await store.list();
              if (!listRes.ok) {
                pushItem('error', `sessions: ${listRes.error.message}`);
                return;
              }
              const arr: readonly { id: string; updatedAt?: string; title?: string }[] = listRes.value;
              if (arr.length === 0) {
                pushItem('system', 'no saved sessions yet — start chatting and atlas will save one automatically.');
                return;
              }
              setSessionList(arr);
              setSelectedSession(null);
              setMarkedSessionIds([]);
              setPendingDeleteSessionIds([]);
              setOverlay('sessions-list');
            } catch (e) {
              pushItem('error', `sessions: ${(e as Error).message}`);
            }
          })();
          return true;
        }
        case 'tools': {
          // Open the tools manage modal. Mirrors Ink's
          // `tools-list` + `tools-manage` overlays. Probes catalog
          // status (web-search docker container, browser playwright
          // chromium, etc.) and lets the user enable/disable/install
          // /start/stop/restart per tool.
          setSelectedTool(null);
          void (async () => {
            try {
              const registered = new Set(props.tools.list().map((t) => t.name));
              const list = await resolveCatalogStatus(registered);
              setToolStatusList(list);
              setOverlay('tools-list');
            } catch (e) {
              pushItem('error', `tools: ${(e as Error).message}`);
            }
          })();
          return true;
        }
        case 'skills': {
          const tokens = arg.split(/\s+/).filter((s) => s.length > 0);
          const sub = (tokens[0] ?? '').toLowerCase();
          // /skills enable|disable <name|fuzzy> — toggle the
          // `disabled:` flag in the SKILL.md frontmatter so the next
          // session loads/skips it. Mirrors Ink's behavior at
          // App.tsx:1127.
          if (sub === 'enable' || sub === 'disable') {
            const target = tokens.slice(1).join(' ').trim();
            if (!target) {
              pushItem('error', `usage: /skills ${sub} <name>`);
              return true;
            }
            const lowered = target.toLowerCase();
            const all = props.skills.list();
            const fuzzy =
              all.find((s) => s.name.toLowerCase() === lowered) ??
              all.find((s) => s.name.toLowerCase().includes(lowered));
            if (!fuzzy) {
              pushItem('error', `no skill matches '${target}'.`);
              return true;
            }
            void setSkillDisabled(fuzzy.path, sub === 'disable').then((r) => {
              if (!r.ok) {
                pushItem('error', `failed to ${sub} ${fuzzy.name}: ${r.error.message}`);
                return;
              }
              pushItem(
                'system',
                sub === 'disable'
                  ? `disabled ${fuzzy.name} (${r.value}). Restart atlas to drop it from the active session.`
                  : `enabled ${fuzzy.name} (${r.value}). Restart atlas to load it into the active session.`
              );
            });
            return true;
          }
          if (sub && sub !== 'list') {
            pushItem('error', 'usage: /skills [list|enable <name>|disable <name>]');
            return true;
          }
          const list = props.skills.list();
          if (list.length === 0) {
            pushItem('system', 'no skills installed — add SKILL.md files under ~/.atlas/skills/');
            return true;
          }
          // Open the skills modal. The action picker per row offers
          // disable + view-description. To re-enable a disabled
          // skill use `/skills enable <name>` (the on-disk file is
          // kept but excluded from `props.skills.list()`).
          setOverlay('skills-list');
          return true;
        }
        case 'status': {
          const lines = [
            `model      ${activeModel}`,
            `agent      ${activeAgent?.name ?? '(none)'}`,
            `mode       ${mode}`,
            `thinking   ${thinking}`,
            `context    ${tokensUsed} / ${contextWindowFor(activeModel, props.modelCatalog)}`,
            `used       ${sessionTokensUsed}`,
            `tools used ${toolCount}`,
            `streaming  ${streaming ? 'yes' : 'no'}`
          ];
          // Workflow phase line — same shape the Ink TUI prints for
          // `/status`. Async because readSignals() hits the disk; the
          // base status block flushes immediately.
          pushItem('system', lines.join('\n'));
          if (activeTask) {
            void (async (): Promise<void> => {
              const signals = await readSignals(activeTask);
              const head = formatPhaseLine(activeTask, signals);
              const meta = `task: ${activeTask.id} — ${activeTask.title}`;
              pushItem('system', `${head}\n${meta}`);
            })();
          } else {
            pushItem('system', formatPhaseLine(null));
          }
          return true;
        }
        case 'thinking':
          if (arg && THINKING_OPTIONS_ALL.some((o) => o.value === arg)) {
            const allowed = thinkingOptions.some((o) => o.value === arg);
            if (!allowed) {
              pushItem(
                'error',
                `${activeModel} doesn't support thinking=${arg}. Try ${thinkingOptions.map((o) => o.value).join('|')}`
              );
            } else {
              setThinking(arg as ThinkingEffort);
              pushItem('system', `→ thinking: ${arg}`);
            }
          } else {
            setOverlay('thinking');
          }
          return true;
        case 'mode':
          if (arg && MODE_OPTIONS.some((o) => o.value === arg)) {
            if (arg === 'autopilot' && mode !== 'autopilot') {
              setOverlay('autopilot-confirm');
            } else {
              setMode(arg as Mode);
              pushItem('system', `→ mode: ${arg}`);
            }
          } else {
            setOverlay('mode');
          }
          return true;
        case 'next': {
          // Stage `*next` in the composer so the next Enter sends it
          // to the orchestrator (which interprets the leading `*` as
          // a workflow control message). Mirrors the Ink TUI's
          // behavior — there it submits inline because submit() is
          // in scope; here we stage to keep handleSlash decoupled
          // from the model-loop wiring.
          const ta = composerRef.current as unknown as {
            setText?: (s: string) => void;
          } | null;
          ta?.setText?.('*next');
          setInput('*next');
          pushItem(
            'system',
            'staged "*next" — press ↵ to ask the orchestrator what to do next.'
          );
          return true;
        }
        case 'restart': {
          if (arg.toLowerCase() !== 'models') {
            pushItem('error', 'usage: /restart models');
            return true;
          }
          pushItem(
            'system',
            'refreshing model catalogs (forcing live fetch)…'
          );
          void (async (): Promise<void> => {
            const cfg = props.config;
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
              const opts: {
                accountId?: string;
                expiresAt?: number;
                forceRefresh?: boolean;
              } = { forceRefresh: true };
              if (codexAuth.accountId) opts.accountId = codexAuth.accountId;
              if (typeof codexAuth.expiresAt === 'number') {
                opts.expiresAt = codexAuth.expiresAt;
              }
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
          return true;
        }
        case 'learn': {
          const sub = arg.toLowerCase().split(/\s+/)[0] ?? '';
          if (sub === 'on') {
            learnEnabledRef.current = true;
            pushItem(
              'system',
              'auto-learn is ON — Atlas will offer to distill skills after hard turns.'
            );
            return true;
          }
          if (sub === 'off') {
            learnEnabledRef.current = false;
            pushItem('system', 'auto-learn is OFF.');
            return true;
          }
          if (sub === 'status') {
            pushItem(
              'system',
              `auto-learn: ${learnEnabledRef.current ? 'on' : 'off'}`
            );
            return true;
          }
          if (sub === '' || sub === 'force') {
            // No subcommand → manually trigger reflection on the
            // current transcript (useful when the heuristic didn't
            // fire but the user knows something reusable just
            // happened).
            // `/learn force` → tell the reflection model NOT to decline
            // even when the turn looks trivial. Useful when the model
            // is being too conservative.
            if (messagesRef.current.length === 0) {
              pushItem('error', 'nothing to learn from yet.');
              return true;
            }
            const force = sub === 'force';
            void launchLearnReflection(
              force ? 'manual /learn force' : 'manual /learn',
              force
            );
            return true;
          }
          pushItem('error', 'usage: /learn [on|off|status|force]');
          return true;
        }
        case 'compact': {
          const tokens = arg.split(/\s+/).filter((s) => s.length > 0);
          const sub = (tokens[0] ?? '').toLowerCase();
          if (!sub || sub === 'now') {
            if (!props.provider) {
              pushItem('error', 'no provider configured');
              return true;
            }
            if (transcript.length < 2) {
              pushItem('system', 'nothing to compact yet.');
              return true;
            }
            const summarizerModel = compactModelRef.current ?? activeModel;
            pushItem('system', `compacting with ${summarizerModel}…`);
            void (async (): Promise<void> => {
              if (!activeProvider) {
                pushItem('error', 'no provider configured');
                return;
              }
              // Compact the live message history (what the agent
              // loop actually sends to the model) — NOT a derived
              // copy. Earlier code rebuilt a minimal Message[] from
              // the transcript and threw the result away, so /compact
              // appeared to do nothing. Now we replace messagesRef
              // and re-base tokensUsed to match the new context size.
              const beforeTokens = estimateContextTokens(messagesRef.current);
              const r = await compactIfNeeded(messagesRef.current, {
                provider: activeProvider,
                summarizerModel,
                limits: {
                  contextTokens: compactContextTokensRef.current,
                  compactThreshold: 0
                }
              });
              if (!r.ok) {
                pushItem('error', `compaction failed: ${r.error.message}`);
                return;
              }
              messagesRef.current = [...r.value.messages];
              const afterTokens = estimateContextTokens(messagesRef.current);
              setTokensUsed(afterTokens);
              if (r.value.compacted || afterTokens < beforeTokens) {
                pushItem(
                  'system',
                  r.value.summarized > 0
                    ? `compacted ${r.value.summarized} older turn${
                        r.value.summarized === 1 ? '' : 's'
                      } — context is now about ${afterTokens.toLocaleString()} tokens.`
                    : `compacted stale tool output — context is now about ${afterTokens.toLocaleString()} tokens.`
                );
              } else {
                pushItem('system', 'nothing eligible to compact.');
              }
            })();
            return true;
          }
          if (sub === 'status') {
            const m =
              compactModelRef.current ?? `(active model: ${activeModel})`;
            pushItem(
              'system',
              `compaction: ${compactEnabledRef.current ? 'on' : 'off'}\n` +
                `  model:     ${m}\n` +
                `  threshold: ${compactThresholdRef.current} of ${compactContextTokensRef.current} tokens`
            );
            return true;
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
            pushItem(
              'system',
              `auto-compaction ${enabled ? 'enabled' : 'disabled'}.`
            );
            return true;
          }
          if (sub === 'model') {
            const id = tokens[1];
            if (!id) {
              pushItem(
                'error',
                'usage: /compact model <id|default>'
              );
              return true;
            }
            const newModel = id === 'default' ? null : id;
            compactModelRef.current = newModel;
            const baseCfg = props.config;
            if (baseCfg) {
              const nextCompaction = { ...baseCfg.compaction };
              if (newModel) nextCompaction.model = newModel;
              else delete (nextCompaction as { model?: string }).model;
              const next: AtlasConfig = {
                ...baseCfg,
                compaction: nextCompaction
              };
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
            return true;
          }
          if (sub === 'threshold') {
            const v = Number(tokens[1] ?? '');
            if (!Number.isFinite(v) || v <= 0 || v > 1) {
              pushItem(
                'error',
                'usage: /compact threshold <fraction 0<v≤1>'
              );
              return true;
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
            return true;
          }
          pushItem(
            'error',
            'usage: /compact [now|status|on|off|model <id|default>|threshold <0..1>]'
          );
          return true;
        }
        case 'onboard': {
          // Brownfield onboarding wizard. Mirrors Ink's
          // `launchOnboardWizard()` + 6-stage `onboard` overlay.
          // Sequence: loading → mode → strategy → pick-model →
          // confirm → running. The running stage calls writeRepoMap
          // then submits the `*onboard` planning prompt.
          setOnboardStatus('estimating cost…');
          setOverlay('onboard-loading');
          void (async () => {
            const r = await estimateOnboardCost({ cwd: props.toolContext.cwd });
            if (!r.ok) {
              pushItem('error', `onboard preflight failed: ${r.error.message}`);
              setOverlay(null);
              return;
            }
            // Pick "cheap" / "fallback" model heuristics — prefer
            // entries the live catalog flags as cheap, then any
            // configured model. Falls back to the active model.
            const allModels =
              props.modelCatalog?.map((m) => m.id) ??
              props.availableModels ??
              [];
            const cheap =
              allModels.find((id) => /haiku|mini|flash|nano/i.test(id)) ??
              activeModel;
            const fallback =
              allModels.find((id) => /sonnet|gpt-5|opus/i.test(id)) ??
              activeModel;
            setOnboardDraft({
              preflight: r.value,
              mode: 'full',
              strategy: 'same-model',
              sameModel: activeModel,
              cheapModel: cheap,
              fallbackModel: fallback,
              stageModels: {
                map: cheap,
                architecture: activeModel,
                onboarding: activeModel
              }
            });
            // Scan for any pre-existing onboarding-shaped docs the
            // user may want the agent to read instead of regenerate.
            // When the repo has none we skip straight to mode pick;
            // otherwise the user gets the multi-select.
            setOnboardStatus('scanning for existing docs…');
            const docs = await findOnboardingDocs({ cwd: props.toolContext.cwd });
            if (docs.ok && docs.value.length > 0) {
              setOnboardDocCandidates(docs.value);
              setOverlay('onboard-existing-docs');
            } else {
              setOnboardDocCandidates([]);
              setOverlay('onboard-mode');
            }
          })();
          return true;
        }
        case 'back': {
          if (!activeTask) {
            pushItem('error', 'no active task to rewind');
            return true;
          }
          const target = (arg.toLowerCase() as Phase);
          if (!PHASES.includes(target)) {
            pushItem(
              'error',
              `usage: /back <${PHASES.filter((p) => p !== 'idle').join('|')}>`
            );
            return true;
          }
          const check = canRewindTo(activeTask, target);
          if (!check.ok) {
            pushItem('error', `cannot rewind: ${check.reason}`);
            return true;
          }
          void (async (): Promise<void> => {
            const u = await updateTask(activeTask, { phase: target });
            if (u.ok) {
              setActiveTask(u.value);
              pushItem(
                'system',
                `phase rewound: ${activeTask.phase} → ${target}`
              );
            } else {
              pushItem('error', `failed to update task: ${u.error.message}`);
            }
          })();
          return true;
        }
        case 'skip': {
          if (!activeTask) {
            pushItem('error', 'no active task');
            return true;
          }
          const idx = PHASES.indexOf(activeTask.phase);
          const next = PHASES[idx + 1];
          if (!next) {
            pushItem(
              'error',
              `already at terminal phase: ${activeTask.phase}`
            );
            return true;
          }
          void (async (): Promise<void> => {
            const u = await updateTask(activeTask, { phase: next });
            if (u.ok) {
              setActiveTask(u.value);
              pushItem(
                'system',
                `phase skipped: ${activeTask.phase} → ${next}`
              );
            } else {
              pushItem('error', `failed to update task: ${u.error.message}`);
            }
          })();
          return true;
        }
        case 'abort': {
          if (!activeTask) {
            pushItem('error', 'no active task to abort');
            return true;
          }
          const taskId = activeTask.id;
          void (async (): Promise<void> => {
            const r = await clearActiveTask(props.toolContext.cwd);
            if (r.ok) {
              setActiveTask(null);
              pushItem(
                'system',
                `task aborted (state preserved at .atlas/tasks/${taskId}/)`
              );
            } else {
              pushItem('error', `failed to abort: ${r.error.message}`);
            }
          })();
          return true;
        }
        case 'quit':
        case 'exit':
          props.onExit?.();
          return true;
        default:
          if (NOT_YET_PORTED.has(cmd)) {
            pushItem(
              'system',
              `/${cmd} is not available in this interface yet.`
            );
            return true;
          }
          pushItem('error', `unknown command: /${cmd} — try /help`);
          return true;
      }
    },
    [
      pushItem,
      transcript,
      props,
      mode,
      switchableAgents,
      thinkingOptions,
      activeModel,
      activeAgent,
      thinking,
      tokensUsed,
      sessionTokensUsed,
      toolCount,
      streaming,
      modelOptions,
      activeTask
    ]
  );

  /**
   * Persist a confirmed learned-skill draft. Writes
   * `~/.atlas/skills/<slug>/SKILL.md` with `kind: learned` and adds
   * the skill to the live registry so framework agents see it on
   * their next turn (without restarting the CLI). Mirrors
   * App.tsx § saveLearnedSkillDraft.
   */
  const saveLearnedSkillDraft = useCallback(
    async (draft: LearnedSkillDraft, reason: string): Promise<void> => {
      setLearnConfirm((s) => (s ? { ...s, stage: 'saving' } : s));
      const r = await saveLearnedSkill({
        name: draft.name,
        description: draft.description,
        triggers: draft.triggers,
        body: draft.body,
        createdBy: activeAgent?.name ?? 'atlas',
        ...(sessionId ? { createdFromSession: sessionId } : {}),
        createdReason: reason
      });
      if (!r.ok) {
        setLearnConfirm((s) =>
          s ? { ...s, stage: 'review', error: r.error.message } : s
        );
        return;
      }
      props.skills.add(r.value);
      setLearnConfirm(null);
      setOverlay(null);
      pushItem(
        'system',
        `✦ saved learned skill: ${r.value.name} — ${r.value.description}`
      );
    },
    [activeAgent, props.skills, sessionId, pushItem]
  );

  const streamLearnDraft = useCallback(
    async (
      messages: readonly Message[],
      reason: string,
      onCancelDraft?: LearnedSkillDraft
    ): Promise<void> => {
      if (!activeProvider) {
        pushItem('error', 'cannot reflect: no provider configured');
        return;
      }
      reflectAbortRef.current?.abort();
      const ac = new AbortController();
      reflectAbortRef.current = ac;
      setLearnConfirm({
        stage: 'reflecting',
        reason,
        ...(onCancelDraft ? { draft: onCancelDraft } : {})
      });
      setOverlay('learn-confirm');
      const effectiveModel =
        props.config?.routerModel ??
        (activeAgent ? agentModels.get(activeAgent.name) : undefined) ??
        activeModel;
      let buf = '';
      try {
        const stream = activeProvider.stream({
          model: effectiveModel,
          messages,
          tools: [],
          signal: ac.signal
        });
        for await (const ev of stream) {
          if (ev.type === 'delta') buf += ev.text;
          else if (ev.type === 'error') {
            if (ac.signal.aborted) return;
            if (onCancelDraft) {
              setLearnConfirm({
                stage: 'review',
                reason,
                draft: onCancelDraft,
                error: `revision failed: ${ev.error.message}`
              });
              setOverlay('learn-confirm');
              return;
            }
            setLearnConfirm(null);
            setOverlay(null);
            pushItem('error', `reflection failed: ${ev.error.message}`);
            return;
          }
        }
      } catch (e) {
        if (ac.signal.aborted) {
          if (reflectAbortRef.current === ac) {
            setLearnConfirm(null);
            setOverlay(null);
          }
          return;
        }
        if (onCancelDraft) {
          setLearnConfirm({
            stage: 'review',
            reason,
            draft: onCancelDraft,
            error: `revision failed: ${(e as Error).message}`
          });
          setOverlay('learn-confirm');
          return;
        }
        setLearnConfirm(null);
        setOverlay(null);
        pushItem('error', `reflection failed: ${(e as Error).message}`);
        return;
      }
      if (reflectAbortRef.current !== ac) return;
      const parsed = parseLearnedSkillDraft(buf);
      if (!parsed.ok) {
        if (onCancelDraft) {
          setLearnConfirm({
            stage: 'review',
            reason,
            draft: onCancelDraft,
            error: `revision parse failed: ${parsed.error}`
          });
          setOverlay('learn-confirm');
          return;
        }
        setLearnConfirm(null);
        setOverlay(null);
        pushItem('error', `reflection parse failed: ${parsed.error}`);
        return;
      }
      if (parsed.draft === null) {
        if (onCancelDraft) {
          setLearnConfirm({
            stage: 'review',
            reason,
            draft: onCancelDraft,
            error: 'revision returned no draft'
          });
          setOverlay('learn-confirm');
          return;
        }
        setLearnConfirm(null);
        setOverlay(null);
        // Tell the user why the overlay closed without a review screen.
        // Without this the "drafting…" panel just disappears and looks
        // like a bug. Reflection deliberately returns `null` when the
        // turn was banter / a trivial fix that nobody would reuse.
        // Note: when the user already passed `force`, the model still
        // ignored the override — surface that explicitly so they don't
        // assume nothing happened.
        const tail = reason.includes('force')
          ? 'The model still declined under force. Likely the transcript is too short — keep working then retry.'
          : 'If you still want to capture it, run `/learn force` to override the heuristic.';
        pushItem(
          'system',
          `✦ atlas reflected — nothing reusable to learn here (${reason}). ${tail}`
        );
        return;
      }
      setLearnConfirm({ stage: 'review', reason, draft: parsed.draft });
    },
    [
      activeProvider,
      activeModel,
      activeAgent,
      agentModels,
      props.config?.routerModel,
      pushItem
    ]
  );

  /**
   * Run the meta-LLM reflection sub-call against the active provider
   * and surface the draft (or "nothing to learn") in the
   * learn-confirm overlay. Mirrors App.tsx § launchLearnReflection.
   * Token cost is bounded — reuses the active provider's `stream`
   * API for a single non-tool round-trip and prefers the cheap
   * `routerModel` when configured.
   */
  const launchLearnReflection = useCallback(
    async (reason: string, force: boolean = false): Promise<void> => {
      await streamLearnDraft(
        buildReflectionMessages(messagesRef.current, reason, { force }),
        reason
      );
    },
    [streamLearnDraft]
  );

  const launchLearnRevision = useCallback(
    async (
      draft: LearnedSkillDraft,
      reason: string,
      changeRequest: string
    ): Promise<void> => {
      await streamLearnDraft(
        buildSkillRevisionMessages(draft, changeRequest, reason),
        reason,
        draft
      );
    },
    [streamLearnDraft]
  );

  const submit = useCallback(async (): Promise<void> => {
    const buffered = composerRef.current?.plainText ?? input;
    let text = buffered.trim();
    if (!text || streaming) return;

    const clearComposer = (): void => {
      setInput('');
      // Drain the textarea's internal buffer so the prompt visually
      // resets after submit. `setText` exists on EditBufferRenderable.
      const ta = composerRef.current as unknown as { setText?: (s: string) => void } | null;
      ta?.setText?.('');
    };

    // When the slash autocomplete popup has matches, Enter picks the
    // highlighted command (and ignores any partial typing). Mirrors
    // the Ink TUI's behavior where `/he<Enter>` runs `/help` if it's
    // the highlighted suggestion.
    if (slashSuggestions.length > 0 && text.startsWith('/')) {
      const pick = slashSuggestions[slashCursor] ?? slashSuggestions[0];
      if (pick) text = `/${pick.name}`;
    }

    if (handleSlash(text)) {
      clearComposer();
      return;
    }

    if (!activeProvider) {
      setError('No provider configured. Set OPENROUTER_API_KEY or run `atlas init`.');
      return;
    }
    if (!activeAgent) {
      setError('No agents installed. Run `atlas init` first.');
      return;
    }

    clearComposer();
    setError(null);
    pushItem('user', text);
    // Reset per-turn telemetry that the auto-learn heuristic reads
    // after `done`. Remember the user message so success-phrase
    // detection has something to look at.
    turnRoundsRef.current = 0;
    turnToolErrorsRef.current = 0;
    lastUserMessageRef.current = text;

    // Per-agent override takes precedence over the global model.
    const effectiveModel =
      agentModels.get(activeAgent.name) ?? activeModel;

    // Background phase classifier — runs in parallel with the model
    // turn so a slow disk write never blocks chat. The router only
    // advances *forward*; `/back`, `/skip`, `/abort` are explicit user
    // overrides. Mirrors App.tsx § classifyIntent integration.
    void (async (): Promise<void> => {
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
          userMessage: text,
          signals
        });
        if (decision.startsNewTask) {
          const created = await startTask({
            cwd,
            title: titleFromMessage(text)
          });
          if (created.ok) setActiveTask(created.value);
        } else if (current && decision.nextPhase !== current.phase) {
          const updated = await updateTask(current, {
            phase: decision.nextPhase
          });
          if (updated.ok) setActiveTask(updated.value);
        }
      } catch {
        // Workflow tracking is observational — never block chat on it.
      }
    })();

    // Build the Atlas system prompt — without this the model has no
    // self-knowledge ("I am Claude / GPT / …" instead of "I am
    // Atlas") and no awareness of the registered tools, skills, or
    // active agent persona. This is what gives the model its Atlas
    // identity and the ability to follow Atlas commands.
    const skillsList = props.skills.list();
    // Six-File Context Pack — best-effort load on every turn (file
    // reads only). Absence (no `context/` scaffolded yet) is normal;
    // the orchestrator already routes to Athena `*scaffold-context-pack`
    // when the project is ripe for it. Without this, the model has no
    // awareness of the local repo's standards, ARCHITECTURE.md, etc.
    let packContent: string | undefined;
    try {
      const pack = await loadContextPack({ cwd: props.toolContext.cwd });
      if (pack.content && pack.content.trim().length > 0) {
        packContent = pack.content;
      }
    } catch {
      // Best-effort — never block a turn on a bad context pack.
    }
    const baseSystem = buildSystemPrompt(activeAgent, skillsList, {
      model: effectiveModel,
      providerLabel: providerLongLabel(activeProviderKind),
      atlasVersion: ATLAS_VERSION,
      ...(packContent ? { contextPack: packContent } : {})
    });
    // Phase-aware addendum — pushes the model toward structured
    // discovery (slot tools + clarify-with-options for vague answers)
    // and toward stopWhen budgets in the plan phase. We use the
    // current task's phase as a proxy; if no task is active yet,
    // treat the very first turn as `discover` so the addendum fires
    // on the user's opening message too.
    const predictedPhase: Phase =
      activeTaskRef.current?.phase ?? 'discover';
    const addendum = phasePromptAddendum(predictedPhase);
    // Drain any pending discover-phase warnings (multi-question
    // detector etc.) so the next system prompt sees them once and the
    // buffer is cleared.
    let pendingWarnings: readonly string[] = [];
    const taskForWarnings = activeTaskRef.current;
    if (taskForWarnings && predictedPhase === 'discover') {
      try {
        pendingWarnings = await consumeDiscoverWarnings(taskForWarnings);
      } catch {
        // observational; never break the loop on a warnings-file glitch
      }
    }
    const warningsBlock =
      pendingWarnings.length > 0
        ? `\n\n## Discover-phase reminders\n\n${pendingWarnings.map((w) => `- ${w}`).join('\n')}`
        : '';
    const systemContent =
      (addendum ? `${baseSystem}\n\n${addendum}` : baseSystem) +
      warningsBlock +
      // House style: forbid emoji output. The OpenTUI variant uses
      // its own ASCII tool icons / status glyphs and emojis render
      // inconsistently across terminals (some skip width, some
      // double-render, some show tofu). Sticking to plain ASCII
      // keeps the chrome scannable for everyone.
      '\n\n## Output style\n\n- Do NOT use emoji or pictographic Unicode in your replies. Use plain ASCII (e.g. `[ok]`, `->`, `*`, `-`) and Markdown (**bold**, `code`) only. The renderer will style them.\n- Do not mention Atlas internal UI framework, renderer, or runtime names unless the user explicitly asks about implementation details.';

    // Append the user turn to the persistent history. The model
    // sees every prior turn so the conversation has continuity.
    messagesRef.current = [
      ...messagesRef.current,
      { role: 'user', content: text }
    ];
    setTokensUsed(estimateContextTokens(messagesRef.current));

    // Lazy session creation: the first user message is what brings a
    // session into existence. Opening Atlas just to swap with
    // `/sessions` no longer creates an empty record on disk. Mirrors
    // App.tsx:1705.
    if (props.sessionStore && !sessionRef.current) {
      const created = await props.sessionStore.create({
        cwd: process.cwd(),
        agent: activeAgent.name,
        model: activeModel
      });
      if (created.ok) {
        sessionRef.current = created.value;
        setSessionId(created.value.id);
        setSessionTitle(created.value.title ?? null);
      } else {
        pushItem('error', `failed to create session: ${created.error.message}`);
      }
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setStreaming(true);
    setThinkingLine(null);
    setThinkingRevealedLines(0);
    // Fresh turn — drop the previous turn's live steps so the strip
    // above the composer starts empty. The previous turn (if any)
    // is already frozen into the transcript as a 'timeline' card.
    setCurrentTurnSteps([]);
    // Pre-seed an empty `kind:'timeline'` transcript item right
    // after the user message. We update the same item's `steps`
    // array as events stream in. This puts the activity list ABOVE
    // the assistant reply (matching VS Code chat ordering: user →
    // activity → answer) instead of being appended after.
    transcriptKey.current += 1;
    const timelineKey = `t${transcriptKey.current}`;
    liveTimelineKey.current = timelineKey;
    // Pre-seed a "Waiting for response…" step so there's immediate
    // feedback between Enter and the provider's first byte. Without
    // this the timeline card sits blank for the network round-trip
    // and the user can't tell anything is happening. The step is
    // closed by `finishWaiting()` on the first delta / thinking /
    // tool_call_start event.
    const waitingStepId = `step-wait-${Date.now()}`;
    setTranscript((prev) => [
      ...prev,
      {
        key: timelineKey,
        kind: 'timeline',
        text: '',
        steps: [
          {
            id: waitingStepId,
            kind: 'thinking',
            label: 'Waiting for response',
            status: 'running',
            startedAt: Date.now()
          }
        ]
      }
    ]);
    setCurrentTurnSteps([
      {
        id: waitingStepId,
        kind: 'thinking',
        label: 'Waiting for response',
        status: 'running',
        startedAt: Date.now()
      }
    ]);
    let waitingFinished = false;
    const finishWaiting = (): void => {
      if (waitingFinished) return;
      waitingFinished = true;
      setCurrentTurnSteps((prev) =>
        prev.filter((s) => s.id !== waitingStepId)
      );
    };
    let assistantBuffer = '';
    const author = activeAgent.name;
    // Per-tool-call start timestamps so we can show elapsed time on
    // completion in the sidebar.
    const toolStartedAt = new Map<string, number>();
    // Reasoning option built from the user's `/thinking` pick. Off
    // means we omit the field entirely so the provider uses its
    // default; xhigh maps to `effort: high` plus a generous max-tokens
    // budget. Mirrors App.tsx (§ reasoningOpt).
    const reasoningOpt = buildReasoning(thinking as ThinkingLevel);

    // Auto-compaction — if enabled and the running message count is
    // above the configured threshold, fold older turns into a single
    // summary system message *before* sending. Without this, long
    // sessions slowly hit the context window and the provider 400s.
    if (
      compactEnabledRef.current &&
      messagesRef.current.length >= 6 &&
      activeProvider
    ) {
      const summarizerModel = compactModelRef.current ?? effectiveModel;
      try {
        const beforeTokens = estimateContextTokens(messagesRef.current);
        const compRes = await compactIfNeeded(messagesRef.current, {
          provider: activeProvider,
          summarizerModel,
          limits: {
            contextTokens: compactContextTokensRef.current,
            compactThreshold: compactThresholdRef.current
          },
          signal: ac.signal
        });
        if (compRes.ok) {
          messagesRef.current = [...compRes.value.messages];
          const afterTokens = estimateContextTokens(messagesRef.current);
          setTokensUsed(afterTokens);
          if (compRes.value.compacted || afterTokens < beforeTokens) {
            pushItem(
              'system',
              compRes.value.summarized > 0
                ? `(auto-compacted ${compRes.value.summarized} older turn${
                    compRes.value.summarized === 1 ? '' : 's'
                  }; context is now about ${afterTokens.toLocaleString()} tokens)`
                : `(auto-compacted stale tool output; context is now about ${afterTokens.toLocaleString()} tokens)`
            );
          }
        }
      } catch {
        // Best-effort — never let a flaky summariser break the chat turn.
      }
    }

    // After a `turn_end`, the next delta starts a NEW assistant
    // entry instead of overwriting the just-committed one. This is
    // critical for multi-round responses: round 1 produces text,
    // round 2 (post-tool-call) produces more text — both must
    // appear, not the second replacing the first.
    const turnBoundary = { current: false };

    const flushAssistant = (): void => {
      // Strip any complete `<atlas:question>` blocks and hide an
      // in-progress (still-streaming) opener so the raw protocol
      // never flashes into the live transcript. Mirrors Ink's
      // flushDelta at App.tsx:1935.
      const visible = renderVisibleAssistant(assistantBuffer);
      setTranscript((prev) => {
        const last = prev[prev.length - 1];
        if (
          last &&
          last.kind === 'assistant' &&
          last.author === author &&
          !turnBoundary.current
        ) {
          if (last.text === visible) return prev;
          // Never overwrite a previously-rendered assistant body
          // with empty text — that was producing a bare "ATLAS"
          // header with no content at the bottom of multi-round
          // turns whose final round was just an `<atlas:question>`
          // block (visible strips down to "" after extraction).
          if (visible.length === 0) return prev;
          return [...prev.slice(0, -1), { ...last, text: visible }];
        }
        if (visible.length === 0) return prev;
        // Crossing a turn boundary clears the flag — subsequent
        // deltas in the *same* round will keep updating this new
        // entry until the next `turn_end`.
        turnBoundary.current = false;
        transcriptKey.current += 1;
        return [
          ...prev,
          {
            key: `t${transcriptKey.current}`,
            kind: 'assistant',
            text: visible,
            author
          }
        ];
      });
    };

    // ----- per-turn timeline helpers (declared BEFORE the try so
    // they're out of the TDZ when handleEvent runs inside it).
    // The id of the currently-open `Thinking…` step, if any. We
    // collapse contiguous reasoning into one row (so the strip
    // doesn't fill with 50× `Thinking…` rows on chatty providers)
    // and close it as soon as a tool call or assistant text
    // arrives — that's the natural "transition" point.
    let currentThinkingStepId: string | null = null;
    // Per-step accumulator. Reset every time a thinking step
    // closes, so a second round of reasoning in the same turn
    // gets its own buffer instead of inheriting the first.
    let thinkingAccum = '';
    const finishThinking = (): void => {
      if (!currentThinkingStepId) return;
      const id = currentThinkingStepId;
      currentThinkingStepId = null;
      thinkingAccum = '';
      setCurrentTurnSteps((prev) =>
        prev.map((s) =>
          s.id === id && s.status === 'running'
            ? { ...s, status: 'ok', finishedAt: Date.now() }
            : s
        )
      );
    };

    try {
      openTuiLog.debug(
        {
          provider: activeProvider.name,
          providerKind: activeProviderKind,
          model: effectiveModel,
          historyMessages: messagesRef.current.length,
          registeredTools: props.tools.list().length,
          supportsToolCalling: activeProvider.supportsToolCalling !== false,
          atlasMode: props.config?.atlasMode ?? 'full',
          localToolMode: props.config?.providers.local.toolMode ?? null
        },
        'opentui starting agent loop'
      );
      for await (const ev of runAgentLoop({
        provider: activeProvider,
        model: effectiveModel,
        ...(props.fallbackModels ? { fallbackModels: props.fallbackModels } : {}),
        tools: props.tools,
        ...(props.hooks ? { hooks: props.hooks } : {}),
        toolContext: {
          ...props.toolContext,
          // Mode-driven approval policy: plan = read-only, build /
          // autopilot = let tools run. Build asks for side-effect
          // tools, autopilot allows them unattended, and plan denies
          // them so users get a real read-only mode.
          approve: buildApprovalPolicy(mode),
          shipDefaults: {
            autoResolve: shipAutoResolveRef.current,
            promptOnConflict: shipPromptOnConflictRef.current
          },
          // Conflict callback. When prompt-on-conflict is enabled,
          // pop the ship-conflict overlay and wait for the user's
          // pick. Otherwise (or if the user hits Esc → null), fall
          // back to the configured strategy so the loop never blocks
          // forever.
          shipResolveAsk: async (req) =>
            new Promise((resolve) => {
              if (!shipPromptOnConflictRef.current) {
                resolve({ strategy: shipAutoResolveRef.current, persist: false });
                return;
              }
              shipResolveResolverRef.current = (pick) => {
                resolve(
                  pick ?? { strategy: shipAutoResolveRef.current, persist: false }
                );
              };
              setShipConflict({
                base: req.base,
                branch: req.branch,
                conflictFiles: req.conflictFiles,
                selected:
                  shipAutoResolveRef.current === 'abort'
                    ? 'ai'
                    : shipAutoResolveRef.current,
                persist: false
              });
              setOverlay('ship-conflict');
            }),
          callingAgent: { name: activeAgent.name },
          signal: ac.signal
        },
        // Seed with the system prompt + full prior history so the
        // model sees Atlas identity, the registered tool inventory,
        // skill index, and every earlier turn of this session.
        initialMessages: [
          { role: 'system', content: systemContent },
          ...messagesRef.current
        ],
        ...(reasoningOpt ? { reasoning: reasoningOpt } : {}),
        signal: ac.signal
      })) {
        handleEvent(ev);
      }
    } catch (e) {
      pushItem('error', `loop crashed: ${(e as Error).message}`);
    } finally {
      finishWaiting();
      flushAssistant();
      abortRef.current = null;
      setStreaming(false);
      // Live ephemeral lines belong to the previous turn only.
      // Clear them so they don't linger as ghost rows above the
      // composer between turns.
      setActiveTool(null);
      setThinkingLine(null);
      // Close out any still-running thinking step (model exited
      // mid-thought after an abort, etc.) so the frozen card
      // doesn't show a perpetual `..` glyph.
      if (currentThinkingStepId) {
        const id = currentThinkingStepId;
        currentThinkingStepId = null;
        setCurrentTurnSteps((prev) =>
          prev.map((s) =>
            s.id === id && s.status === 'running'
              ? { ...s, status: 'ok', finishedAt: Date.now() }
              : s
          )
        );
      }
      // Detach the live timeline key so the mirroring effect
      // stops touching the (now frozen) card on the next turn,
      // and reset the typewriter cursor so the next turn's
      // thinking text starts revealing from char 0.
      liveTimelineKey.current = null;
      setThinkingRevealedLines(0);
    }

    function handleEvent(ev: LoopEvent): void {
      switch (ev.type) {
        case 'delta':
          // First visible text means the model is replying — close
          // any open thinking step so the strip flips from `.. Thinking…`
          // to the next phase (or the frozen card is consistent).
          finishWaiting();
          finishThinking();
          assistantBuffer += ev.text;
          flushAssistant();
          break;
        case 'turn_end': {
          // Use the model's final committed message as the source of
          // truth — some providers don't emit deltas for short
          // responses, others batch the whole reply into a single
          // chunk after `tool_call_done`. Mirrors the Ink TUI's
          // safety net at App.tsx:2103.
          const finalText =
            typeof ev.assistantMessage.content === 'string'
              ? ev.assistantMessage.content
              : '';
          // Try to extract a structured-question block. When found:
          // (a) pop the option-picker overlay so the user picks one
          // of the suggested answers; (b) rewrite the visible
          // transcript to show the surrounding narrative without the
          // raw `<atlas:question>` noise. The model history already
          // gets sanitised by the loop's `done` event because we
          // replace messagesRef from ev.messages there.
          const found = finalText ? tryExtractInteraction(finalText) : null;
          if (found) {
            const cleaned = found.remaining.trim();
            assistantBuffer = cleaned;
            flushAssistant();
            setInteractionRequest(found.request);
            setOverlay('option-picker');
          } else if (finalText.length > 0) {
            // Non-question turn — commit the safe rendering (which also
            // hides any in-progress `<atlas:question>` opener if the
            // closing tag never arrived).
            assistantBuffer = renderVisibleAssistant(finalText);
            flushAssistant();
          } else {
            // Tool-only turn — drop the buffer so the next turn
            // starts a fresh assistant entry instead of overwriting
            // this one's text.
            flushAssistant();
          }
          assistantBuffer = '';
          // NOTE: we used to append `ev.assistantMessage` here, but
          // that left orphaned `tool_use` blocks in history when the
          // turn included tool calls (the matching `tool_result`
          // messages only land after `tool_call_done`). Anthropic
          // then 400'd the next request. The canonical history is
          // now installed in `case 'done':` from `ev.messages`.
          // Force the *next* delta to begin a new transcript entry
          // (not replace the just-committed one).
          turnBoundary.current = true;
          break;
        }
        case 'done':
          // Finalise the live timeline that's already pinned in
          // the transcript at submit-time: flip running steps to
          // ok, prune the card if the turn produced zero activity
          // (so a plain text reply doesn't carry an empty header),
          // and detach the live key so the mirroring effect stops
          // touching the frozen card on subsequent turns.
          finishThinking();
          {
            const liveKey = liveTimelineKey.current;
            const frozen: readonly TurnStep[] = currentTurnSteps.map((s) =>
              s.status === 'running'
                ? { ...s, status: 'ok', finishedAt: Date.now() }
                : s
            );
            setTranscript((prev) => {
              if (frozen.length === 0) {
                // Drop the empty placeholder card.
                return prev.filter((it) => it.key !== liveKey);
              }
              return prev.map((it) =>
                it.key === liveKey && it.kind === 'timeline'
                  ? { ...it, steps: frozen }
                  : it
              );
            });
            liveTimelineKey.current = null;
            setCurrentTurnSteps([]);
          }
          // Replace history with the loop's canonical message list —
          // it already contains the assistant's tool_use blocks AND
          // the matching tool_result messages. Without this the next
          // turn's request would have unmatched tool_use ids and
          // Anthropic returns HTTP 400 ("tool_use ids were found
          // without tool_result blocks").
          //
          // Sanitise out any `<atlas:question>` blocks before
          // persisting so subsequent turns don't quote a stale
          // prompt back at the model.
          messagesRef.current = ev.messages.map((m) => {
            if (m.role !== 'assistant' || typeof m.content !== 'string') {
              return m;
            }
            const cleaned = stripInteractionBlocks(m.content);
            if (cleaned === m.content) return m;
            return { ...m, content: cleaned };
          });
          // Persist the session after each turn so resuming the
          // conversation later just works. We mutate the record in
          // place (it's a private ref, never read across renders) and
          // fire-and-forget the disk write — sessions are best-effort,
          // a write failure is logged but doesn't break the chat
          // loop. Mirrors App.tsx:2141.
          if (props.sessionStore && sessionRef.current) {
            const rec = sessionRef.current;
            rec.messages = [...messagesRef.current];
            if (activeAgent) rec.agent = activeAgent.name;
            rec.model = effectiveModel;
            void props.sessionStore.write(rec).then((r) => {
              if (!r.ok) {
                // eslint-disable-next-line no-console
                console.error('session write failed:', r.error.message);
              }
            });
          }
          if (ev.usage) {
            const u = ev.usage;
            const prompt = u.promptTokens ?? 0;
            const completion = u.completionTokens ?? 0;
            const liveContextTokens = prompt + completion;
            setSessionTokensUsed((prev) => prev + liveContextTokens);
            setTokensUsed(
              liveContextTokens > 0
                ? liveContextTokens
                : estimateContextTokens(messagesRef.current)
            );
            // Update spend — best effort: returns undefined when the
            // model isn't in our pricing table (custom OR ids etc.).
            const spent = estimateCost(effectiveModel, prompt, completion);
            if (spent !== undefined) {
              setCostUsd((prev) => prev + spent);
            }
          }
          turnRoundsRef.current = ev.rounds;
          // Self-improvement heuristic: if this turn was "hard"
          // (many rounds, repeated tool errors, or the user signalled
          // success after a struggle), offer to distill a learned
          // skill. The actual reflection is one extra LLM call gated
          // behind user confirmation in the learn-confirm overlay.
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
        case 'tool_call_start': {
          finishWaiting();
          finishThinking();
          const id = ev.call.id ?? `tc-${Date.now()}-${currentTurnSteps.length}`;
          setToolCount((n) => n + 1);
          toolStartedAt.set(id, Date.now());
          setActiveTool({ name: ev.call.name, startedAt: Date.now() });
          setRecentTools((prev) => [
            ...prev.slice(-9),
            {
              key: id,
              name: ev.call.name,
              status: 'running'
            }
          ]);
          // Push the matching timeline step. We key it on the same
          // call id so `tool_call_done` can flip it to past tense
          // without a second lookup.
          const startParts = describeToolCall(ev.call.name, ev.call.arguments, false);
          setCurrentTurnSteps((prev) => [
            ...prev,
            {
              id: `step-${id}`,
              kind: 'tool',
              label: startParts.verb,
              status: 'running',
              startedAt: Date.now(),
              toolName: ev.call.name,
              ...(startParts.filePath ? { filePath: startParts.filePath } : {}),
              ...(startParts.command ? { command: startParts.command } : {})
            }
          ]);
          break;
        }
        case 'tool_call_done': {
          const status: SidebarToolEvent['status'] =
            ev.outcome.type === 'error' ? 'error' : 'done';
          if (ev.outcome.type === 'error') {
            turnToolErrorsRef.current += 1;
          }
          // Pick up todo-list mutations as soon as the tool returns,
          // so the sidebar checklist updates live in lockstep with
          // the agent's state changes.
          if (ev.call.name === 'todo') refreshTodos();
          const id = ev.call.id ?? '';
          const startedAt = toolStartedAt.get(id);
          const elapsedMs =
            startedAt !== undefined ? Date.now() - startedAt : undefined;
          setActiveTool(null);
          setRecentTools((prev) =>
            prev.map((t) =>
              t.key === id || t.name === ev.call.name
                ? {
                    ...t,
                    status,
                    ...(elapsedMs !== undefined ? { elapsedMs } : {})
                  }
                : t
            )
          );
          // Flip the matching timeline step to past tense + ok/error,
          // and surface the first line of the result/error as the
          // step's secondary detail line. This is what gives the
          // strip the "Read App.tsx · 1.2s · 142 lines" feel.
          const stepId = `step-${id}`;
          const detailRaw =
            ev.outcome.type === 'error'
              ? (ev.outcome.error as { message?: string } | undefined)?.message ?? 'error'
              : (ev.outcome as { result?: unknown }).result;
          const detail = firstLineOf(detailRaw);
          const doneParts = describeToolCall(ev.call.name, ev.call.arguments, true);
          const stats =
            ev.outcome.type === 'error'
              ? {}
              : computeLineStats(ev.call.name, ev.call.arguments, detailRaw);
          setCurrentTurnSteps((prev) =>
            prev.map((s) =>
              s.id === stepId
                ? {
                    ...s,
                    status: status === 'error' ? 'error' : 'ok',
                    label: doneParts.verb,
                    finishedAt: Date.now(),
                    ...(doneParts.filePath ? { filePath: doneParts.filePath } : {}),
                    ...(doneParts.command ? { command: doneParts.command } : {}),
                    ...(typeof stats.linesAdded === 'number'
                      ? { linesAdded: stats.linesAdded }
                      : {}),
                    ...(typeof stats.linesRemoved === 'number'
                      ? { linesRemoved: stats.linesRemoved }
                      : {}),
                    ...(detail ? { detail } : {})
                  }
                : s
            )
          );
          break;
        }
        case 'thinking': {
          finishWaiting();
          // Accumulate the model's reasoning. `thinkingLine` holds
          // the full buffer for the typewriter ticker; `thinkingAccum`
          // is the per-step copy so the frozen card still has the
          // text after the live state is cleared.
          setThinkingLine((prev) => (prev ?? '') + ev.text);
          thinkingAccum += ev.text;
          // Mirror VS Code's reasoning panel: open a single
          // Thinking step on the first fragment, then keep
          // overwriting its detail with the full accumulated
          // buffer. The step closes when a tool call or assistant
          // text arrives.
          if (!currentThinkingStepId) {
            const id = `step-think-${Date.now()}-${currentTurnSteps.length}`;
            currentThinkingStepId = id;
            setCurrentTurnSteps((prev) => [
              ...prev,
              {
                id,
                kind: 'thinking',
                label: 'Thinking',
                status: 'running',
                startedAt: Date.now(),
                detail: thinkingAccum
              }
            ]);
          } else {
            const id = currentThinkingStepId;
            const detail = thinkingAccum;
            setCurrentTurnSteps((prev) =>
              prev.map((s) => (s.id === id ? { ...s, detail } : s))
            );
          }
          break;
        }
        case 'error':
          pushItem('error', ev.error.message);
          break;
        default:
          break;
      }
    }
  }, [
    input,
    streaming,
    props,
    activeAgent,
    activeModel,
    activeProvider,
    activeProviderKind,
    agentModels,
    mode,
    thinking,
    pushItem,
    handleSlash,
    buildApprovalPolicy,
    slashSuggestions,
    slashCursor,
    launchLearnReflection
  ]);

  // Global hotkeys. Composer-local keys (Enter, Ctrl-J, Backspace,
  // arrows, paste) are handled by the focused `<textarea>`.
  useKeyboard((key) => {
    if (overlay) {
      // Ship-conflict overlay swallows all input — number keys (1-4)
      // jump to a strategy, ↑/↓ move the cursor, p / space toggles
      // persist, ↵ confirms, Esc resolves with null (the agent loop
      // then falls back to the configured default).
      if (overlay === 'ship-conflict' && shipConflict) {
        const STRATS = ['abort', 'ours', 'theirs', 'ai'] as const;
        if (key.name === 'escape') {
          shipResolveResolverRef.current?.(null);
          shipResolveResolverRef.current = null;
          setShipConflict(null);
          setOverlay(null);
          return;
        }
        if (key.name === 'return') {
          if (shipConflict.persist) {
            shipAutoResolveRef.current = shipConflict.selected;
            const baseCfg = props.config;
            if (baseCfg) {
              const next: AtlasConfig = {
                ...baseCfg,
                ship: { ...baseCfg.ship, autoResolve: shipConflict.selected }
              };
              void saveConfig(next).then((r) => {
                if (!r.ok) pushItem('error', `save failed: ${r.error.message}`);
              });
            }
            pushItem(
              'system',
              `auto-resolve default set to ${shipConflict.selected}.`
            );
          }
          shipResolveResolverRef.current?.({
            strategy: shipConflict.selected,
            persist: shipConflict.persist
          });
          shipResolveResolverRef.current = null;
          setShipConflict(null);
          setOverlay(null);
          return;
        }
        if (key.name === 'up') {
          const i = STRATS.indexOf(shipConflict.selected);
          const nextSel = STRATS[(i - 1 + STRATS.length) % STRATS.length];
          if (nextSel) setShipConflict({ ...shipConflict, selected: nextSel });
          return;
        }
        if (key.name === 'down' || key.name === 'tab') {
          const i = STRATS.indexOf(shipConflict.selected);
          const nextSel = STRATS[(i + 1) % STRATS.length];
          if (nextSel) setShipConflict({ ...shipConflict, selected: nextSel });
          return;
        }
        if (key.sequence === 'p' || key.sequence === ' ') {
          setShipConflict({ ...shipConflict, persist: !shipConflict.persist });
          return;
        }
        const n = Number(key.sequence ?? '');
        if (Number.isInteger(n) && n >= 1 && n <= 4) {
          const pick = STRATS[n - 1];
          if (pick) setShipConflict({ ...shipConflict, selected: pick });
          return;
        }
        return;
      }
      if (key.name === 'escape') {
        if (overlay === 'learn-confirm' && learnConfirm?.stage === 'change' && learnConfirm.draft) {
          setLearnConfirm({
            stage: 'review',
            reason: learnConfirm.reason,
            draft: learnConfirm.draft
          });
          return;
        }
        // Cancel an in-flight reflection sub-call so closing the
        // overlay also stops the streaming LLM call.
        if (overlay === 'learn-confirm' && learnConfirm?.stage === 'reflecting') {
          reflectAbortRef.current?.abort();
          if (learnConfirm.draft) {
            setLearnConfirm({
              stage: 'review',
              reason: learnConfirm.reason,
              draft: learnConfirm.draft
            });
            return;
          }
        }
        if (overlay === 'tool-approval') {
          toolApprovalResolverRef.current?.({
            action: 'deny',
            reason: 'user dismissed approval prompt'
          });
          toolApprovalResolverRef.current = null;
          setToolApproval(null);
        }
        setOverlay(null);
        if (overlay === 'learn-confirm') setLearnConfirm(null);
        return;
      }
      if (key.ctrl && key.name === 'c') {
        if (overlay === 'learn-confirm' && learnConfirm?.stage === 'change' && learnConfirm.draft) {
          setLearnConfirm({
            stage: 'review',
            reason: learnConfirm.reason,
            draft: learnConfirm.draft
          });
          return;
        }
        if (overlay === 'learn-confirm' && learnConfirm?.stage === 'reflecting') {
          reflectAbortRef.current?.abort();
          if (learnConfirm.draft) {
            setLearnConfirm({
              stage: 'review',
              reason: learnConfirm.reason,
              draft: learnConfirm.draft
            });
            return;
          }
        }
        if (overlay === 'tool-approval') {
          toolApprovalResolverRef.current?.({
            action: 'deny',
            reason: 'user dismissed approval prompt'
          });
          toolApprovalResolverRef.current = null;
          setToolApproval(null);
        }
        setOverlay(null);
        if (overlay === 'learn-confirm') setLearnConfirm(null);
        return;
      }
      return;
    }

    if (key.ctrl && key.name === 'c') {
      // Ctrl-C ONLY aborts the in-flight model turn. We never exit
      // on Ctrl-C — many users rely on it for terminal copy
      // (especially with selection-on-copy enabled). The dedicated
      // exit hotkey is Ctrl-D pressed twice in a row.
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      return;
    }
    if (key.ctrl && key.name === 'd') {
      // Two-stage exit: first Ctrl-D arms the latch (with a 2s
      // window) and surfaces a hint, second Ctrl-D within the
      // window exits. Mirrors the standard REPL exit etiquette.
      const now = Date.now();
      if (now - exitArmedAt.current < 2000) {
        exitArmedAt.current = 0;
        props.onExit?.();
        return;
      }
      exitArmedAt.current = now;
      pushItem('system', '(press Ctrl-D again within 2s to exit)');
      return;
    }
    if (key.ctrl && key.name === 'l') {
      setTranscript([]);
      messagesRef.current = [];
      setTokensUsed(0);
      setSessionTokensUsed(0);
      setCostUsd(0);
      return;
    }
    if (key.ctrl && key.name === 'x') {
      // Open the copy picker so the user can choose any message in
      // the transcript and copy its full text to the system
      // clipboard via OSC 52. Works in iTerm2, kitty, WezTerm,
      // Alacritty, foot, Windows Terminal, and tmux (when
      // `set-clipboard on` is set in tmux.conf). We can't read the
      // terminal's mouse selection from inside the alt-screen
      // renderer, so the picker is the in-app equivalent.
      const copyable = transcript.filter(
        (t) => t.kind === 'assistant' || t.kind === 'user' || t.kind === 'thinking'
      );
      if (copyable.length === 0) {
        pushItem('system', '(no messages to copy yet)');
        return;
      }
      setOverlay('copy-picker');
      return;
    }
    // Scrollback — PgUp / PgDn / Home / End. The chat scrollbox is
    // not focused (the textarea is) so its built-in handlers never
    // fire; we forward the key to the underlying renderable's
    // `scrollBy` instead. Half-viewport per page like a terminal
    // pager.
    if (key.name === 'pageup') {
      scrollboxRef.current?.scrollBy(-0.5, 'viewport');
      return;
    }
    if (key.name === 'pagedown') {
      scrollboxRef.current?.scrollBy(0.5, 'viewport');
      return;
    }
    if (key.name === 'home' && !composerFocused) {
      scrollboxRef.current?.scrollBy(-1, 'content');
      return;
    }
    if (key.name === 'end' && !composerFocused) {
      scrollboxRef.current?.scrollBy(1, 'content');
      return;
    }
    // Shift+Up / Shift+Down — single-line scroll, parity with the
    // Ink TUI. Works regardless of composer focus so users can
    // skim the transcript without losing their input draft.
    if (key.shift && key.name === 'up') {
      scrollboxRef.current?.scrollBy(-1, 'absolute');
      return;
    }
    if (key.shift && key.name === 'down') {
      scrollboxRef.current?.scrollBy(1, 'absolute');
      return;
    }
    // Slash autocomplete navigation — only active when the popup
    // has matches. ↑/↓ cycle, Tab autocompletes the highlighted
    // command name into the composer (so the user can keep typing
    // arguments).
    if (slashSuggestions.length > 0) {
      if (key.name === 'up') {
        setSlashCursor((i) =>
          i <= 0 ? slashSuggestions.length - 1 : i - 1
        );
        return;
      }
      if (key.name === 'down') {
        setSlashCursor((i) =>
          i >= slashSuggestions.length - 1 ? 0 : i + 1
        );
        return;
      }
      if (key.name === 'tab' && !key.shift) {
        const pick =
          slashSuggestions[slashCursor] ?? slashSuggestions[0];
        if (pick) {
          const next = `/${pick.name} `;
          setInput(next);
          const ta = composerRef.current as unknown as {
            setText?: (s: string) => void;
          } | null;
          ta?.setText?.(next);
        }
        return;
      }
    }
    if (key.name === 'tab' && !key.shift) {
      // Only open the picker when there's something to pick. On a
      // default install (orchestrator-only) Tab is a no-op — the
      // statusbar surfaces the hotkey but pressing it does nothing
      // until the user installs a custom agent under ~/.atlas/agents/.
      if (switchableAgents.length > 1) setOverlay('agent');
      return;
    }
    if (key.ctrl && key.name === 'o') {
      setOverlay('model');
      return;
    }
    if (key.ctrl && key.name === 't') {
      setOverlay('thinking');
      return;
    }
    if (key.ctrl && key.name === 'p') {
      setOverlay('mode');
      return;
    }
  });

  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // Always pull focus back to the composer when no overlay is open.
  // Without this, a fresh terminal launch leaves the renderable
  // unfocused until the user clicks — typing immediately just dropped
  // characters. Mirrors the Ink TUI where the chat input is the
  // implicit focus target on every redraw.
  useEffect(() => {
    if (overlay === null) {
      composerRef.current?.focus();
    }
  }, [overlay]);

  const showSidebar = width >= SIDEBAR_MIN_COLS;
  const composerFocused = overlay === null;

  return (
    <box
      style={{
        width,
        height,
        flexDirection: 'column',
        backgroundColor: palette.background
      }}
    >
      <Header
        agentName={activeAgent?.name ?? 'atlas'}
        agentRole={
          activeAgent
            ? `${activeAgent.role ?? 'Agent'} (${activeAgent.name})`
            : 'Atlas'
        }
        model={activeModel}
        providerTag={providerTagFor(activeModel, props.modelCatalog)}
        atlasMode={activeAtlasMode}
        mode={mode}
        thinking={thinking}
        streaming={streaming}
        sessionTitle={sessionTitle ?? (sessionId ? sessionId.slice(0, 8) : null)}
        notConnected={!activeProvider}
      />

      {/* Body: chat column + optional right sidebar */}
      <box
        style={{
          width: '100%',
          flexGrow: 1,
          flexDirection: 'row',
          backgroundColor: palette.background,
          position: 'relative'
        }}
      >
        <box
          style={{
            flexGrow: 1,
            flexDirection: 'column',
            backgroundColor: palette.backgroundPanel
          }}
        >
          <scrollbox
            ref={scrollboxRef as never}
            style={{
              width: '100%',
              flexGrow: 1,
              backgroundColor: palette.backgroundPanel,
              paddingLeft: 1,
              paddingRight: 1
            }}
            rootOptions={{ backgroundColor: palette.backgroundPanel }}
            wrapperOptions={{ backgroundColor: palette.backgroundPanel }}
            viewportOptions={{ backgroundColor: palette.backgroundPanel }}
            contentOptions={{ backgroundColor: palette.backgroundPanel }}
            stickyScroll
            stickyStart="bottom"
          >
            {transcript.length === 0 ? (
              <Splash defaultModel={activeModel} notConnected={!activeProvider} />
            ) : (
              transcript.map((item) => {
                const color =
                  item.kind === 'user'
                    ? palette.text
                    : item.kind === 'assistant'
                      ? palette.primary
                      : item.kind === 'error'
                        ? palette.error
                        : item.kind === 'system'
                          ? palette.textMuted
                          : palette.textDim;
                // Assistant turns get full inline-markdown rendering
                // (**bold**, *italic*, `code`, ~~strike~~, headings).
                // Without this the model's emphasis markers leak
                // through as literal `**` characters and the chat
                // looks like raw text. User turns and system lines
                // stay verbatim.
                if (item.kind === 'assistant') {
                  // ATLAS replies wear the accent (purple) so they
                  // contrast clearly against the user's primary-blue
                  // prompt — same role-color convention as VS Code
                  // Copilot Chat. Author label is uppercased for
                  // brand consistency.
                  const authorLabel = (item.author ?? 'atlas').toUpperCase();
                  return (
                    <box
                      key={item.key}
                      style={{
                        width: '100%',
                        flexDirection: 'column',
                        marginBottom: 1,
                        backgroundColor: palette.backgroundPanel
                      }}
                    >
                      <box
                        style={{
                          flexDirection: 'row',
                          backgroundColor: palette.backgroundPanel
                        }}
                      >
                        <text fg={palette.accent} attributes={BOLD_ATTR}>
                          {`${authorLabel}  `}
                        </text>
                      </box>
                      {renderMarkdownBlock(
                        item.text,
                        palette.text,
                        `md_${item.key}`
                      )}
                    </box>
                  );
                }
                if (item.kind === 'timeline' && item.steps) {
                  // Live items get the typewriter-gated reveal so
                  // the in-flight thinking text scrolls in at a
                  // readable pace; frozen items show everything.
                  const isLive = item.key === liveTimelineKey.current;
                  const reveal = isLive ? thinkingRevealedLines : Infinity;
                  return (
                    <box
                      key={item.key}
                      style={{
                        width: '100%',
                        flexDirection: 'column',
                        marginBottom: 1,
                        backgroundColor: palette.backgroundPanel
                      }}
                    >
                      {renderTimelineCard(item.steps, item.key, reveal)}
                    </box>
                  );
                }
                // User turns get a bold primary-blue label so the
                // eye can hop between USER → ATLAS rows without
                // re-reading. Errors and system lines keep their
                // single-color compact format.
                if (item.kind === 'user') {
                  return (
                    <box
                      key={item.key}
                      style={{
                        width: '100%',
                        flexDirection: 'column',
                        marginBottom: 1,
                        backgroundColor: palette.backgroundPanel
                      }}
                    >
                      <box
                        style={{
                          flexDirection: 'row',
                          backgroundColor: palette.backgroundPanel
                        }}
                      >
                        <text fg={palette.primaryBright} attributes={BOLD_ATTR}>
                          {'YOU  '}
                        </text>
                      </box>
                      <box
                        style={{
                          flexDirection: 'row',
                          backgroundColor: palette.backgroundPanel
                        }}
                      >
                        <text fg={palette.text}>{item.text}</text>
                      </box>
                    </box>
                  );
                }
                const prefix =
                  item.kind === 'error'
                    ? '! '
                    : '';
                return (
                  <box
                    key={item.key}
                    style={{
                      width: '100%',
                      flexDirection: 'column',
                      marginBottom: 1,
                      backgroundColor: palette.backgroundPanel
                    }}
                  >
                    <text fg={color}>{prefix + item.text}</text>
                  </box>
                );
              })
            )}
          </scrollbox>

          {/* The activity timeline now lives directly in the
              transcript scrollback above the assistant reply (see
              the `kind === 'timeline'` branch in the renderer
              above), matching VS Code Copilot's user → activity →
              answer ordering. No ephemeral strip above the
              composer — that broke the panel background and
              forced the user's eye to ping-pong between two
              places to follow the model. */}

          {/* Composer — multi-line. Enter sends; Shift-Enter,
              Alt-Enter, and Ctrl-J insert newlines. The outer box
              auto-grows upward as the user adds rows (the
              scrollbox above has flexGrow:1 and shrinks to make
              room) — same UX VS Code's chat input has when lines
              break. Border turns bright yellow while the model is
              streaming so the user can see "I'm working" at a
              glance — mirrors the Ink TUI.

              Note on Shift-Enter: most terminals collapse Shift
              modifiers on Return into a bare CR, so the
              `{ name:'return', shift:true }` binding only fires in
              terminals that enable the Kitty keyboard protocol or
              `modifyOtherKeys` (Kitty, WezTerm, recent iTerm2).
              The Alt-Enter and Ctrl-J bindings are the universal
              fallbacks. */}
          {(() => {
            // Compute a wrap-aware row count so the box also grows
            // when a single long line wraps (not just on explicit
            // newlines). We approximate the available width as the
            // chat-column width minus the border (2) and padding
            // (2). For the very first render we don't know the
            // terminal width yet — fall back to 80 cols.
            const innerCols =
              Math.max(20, width - (showSidebar ? 38 : 0) - 4);
            const lines = input.length === 0 ? [''] : input.split('\n');
            const wrappedRows = lines.reduce(
              (acc, l) => acc + Math.max(1, Math.ceil(l.length / innerCols)),
              0
            );
            // 1 row min, cap at 12 so a paste doesn't eat the chat.
            const rows = Math.min(12, Math.max(1, wrappedRows));
            return (
              <box
                style={{
                  width: '100%',
                  // The +2 accounts for the single-row borders top &
                  // bottom that wrap the textarea inside this box.
                  height: rows + 2,
                  backgroundColor: palette.backgroundPanel,
                  borderColor: streaming
                    ? palette.warning
                    : composerFocused
                      ? palette.primary
                      : palette.border,
                  borderStyle: 'single',
                  paddingLeft: 1,
                  paddingRight: 1
                }}
              >
                <textarea
                  ref={composerRef}
                  focused={composerFocused}
                  placeholder={
                    streaming
                      ? '… streaming — Ctrl-C to abort'
                      : 'Message Atlas (↵ send · Shift-↵ / Alt-↵ / Ctrl-J newline · / for commands)'
                  }
                  placeholderColor={palette.textDim}
                  backgroundColor={palette.backgroundPanel}
                  focusedBackgroundColor={palette.backgroundPanel}
                  textColor={palette.text}
                  focusedTextColor={palette.text}
                  cursorColor={palette.primaryBright}
                  wrapMode="word"
                  keyBindings={[
                    { name: 'return', action: 'submit' },
                    // Shift-Enter — only delivered by terminals with
                    // the Kitty keyboard protocol / CSI-u / modifyOtherKeys.
                    { name: 'return', shift: true, action: 'newline' },
                    // Alt-Enter — universal fallback that works in
                    // gnome-terminal, xterm, Windows Terminal, etc.
                    { name: 'return', meta: true, action: 'newline' },
                    // Ctrl-J — IEEE-1003 line feed, works everywhere.
                    { name: 'j', ctrl: true, action: 'newline' }
                  ]}
                  onContentChange={() => {
                    const t = composerRef.current?.plainText ?? '';
                    setInput(t);
                  }}
                  onSubmit={() => {
                    void submit();
                  }}
                  style={{
                    width: '100%',
                    height: rows
                  }}
                />
              </box>
            );
          })()}
        </box>

        {showSidebar ? (
          <Sidebar
            tokensUsed={tokensUsed}
            sessionTokensUsed={sessionTokensUsed}
            contextWindow={contextWindowFor(activeModel, props.modelCatalog)}
            streaming={streaming}
            toolCount={toolCount}
            recentTools={recentTools}
            thinkingLine={thinkingLine}
            costUsd={costUsd}
            phaseLine={activeTask ? formatPhaseLine(activeTask) : null}
            todos={todos}
          />
        ) : null}

        {/* Slash command autocomplete — opens *from* the chat bar
            (full chat-column width, anchored just above the
            composer). The popup is non-modal: the composer stays
            focused and the global useKeyboard listener handles
            ↑/↓/Tab. Enter is intercepted in `submit()` to expand
            the highlighted command before dispatch. */}
        {slashSuggestions.length > 0 ? (
          <SlashAutocomplete
            suggestions={slashSuggestions}
            highlightIndex={slashCursor}
            // Match the composer's footprint: full chat-column width
            // (terminal width minus the sidebar when shown), flush to
            // the left edge, anchored at bottom = composer (3 rows)
            // + status bar (1 row).
            left={0}
            width={Math.max(40, width - (showSidebar ? 38 : 0))}
            bottom={4}
          />
        ) : null}

        {overlay === 'agent' && agentOptions.length > 0 ? (
          <Picker
            title="select agent"
            options={agentOptions}
            initialValue={activeAgent?.name}
            onChoose={(v) => {
              setActiveAgentName(v);
              pushItem('system', `→ agent: ${v}`);
              setOverlay(null);
            }}
            onCancel={() => setOverlay(null)}
          />
        ) : null}
        {overlay === 'model' ? (
          <ColoredGroupedPicker
            title="select model"
            entries={modelEntries}
            initialValue={activeModel}
            hint="type to filter · ↑/↓ navigate · ★ popular · ↵ choose · Ctrl-U clear · Esc cancel"
            onChoose={(v) => {
              if (switchToModel(v)) {
                pushItem('system', `→ model: ${v}`);
              }
              setOverlay(null);
            }}
            onCancel={() => setOverlay(null)}
          />
        ) : null}
        {overlay === 'thinking' ? (
          <Picker
            title="thinking effort"
            options={thinkingOptions.length > 0 ? thinkingOptions : THINKING_OPTIONS_ALL}
            initialValue={thinking}
            hint={
              thinkingOptions.length === 0
                ? `↑/↓ navigate · ↵ choose · Esc cancel — ${activeModel} reports no thinking metadata`
                : undefined
            }
            onChoose={(v) => {
              setThinking(v as ThinkingEffort);
              pushItem('system', `→ thinking: ${v}`);
              setOverlay(null);
            }}
            onCancel={() => setOverlay(null)}
          />
        ) : null}
        {overlay === 'mode' ? (
          <Picker
            title="permission mode"
            options={MODE_OPTIONS}
            initialValue={mode}
            onChoose={(v) => {
              if (v === 'autopilot' && mode !== 'autopilot') {
                setOverlay('autopilot-confirm');
                return;
              }
              setMode(v as Mode);
              pushItem('system', `→ mode: ${v}`);
              setOverlay(null);
            }}
            onCancel={() => setOverlay(null)}
          />
        ) : null}
        {overlay === 'autopilot-confirm' ? (
          <Confirm
            title="enable autopilot?"
            message="Autopilot auto-approves every tool call — file writes, shell commands, network access — with no confirmation. Use only when you trust the current task."
            confirmLabel="Enable autopilot"
            cancelLabel="Stay in build"
            tone="warn"
            onConfirm={() => {
              setMode('autopilot');
              pushItem('system', '→ mode: autopilot');
              setOverlay(null);
            }}
            onCancel={() => setOverlay(null)}
          />
        ) : null}
        {overlay === 'tool-approval' && toolApproval ? (
          <Confirm
            title={`approve tool · ${toolApproval.tool}`}
            message={`This tool can change files, run commands, or modify project state.\n\n${toolApproval.inputPreview}`}
            confirmLabel="Approve"
            cancelLabel="Deny"
            tone="warn"
            onConfirm={() => {
              toolApprovalResolverRef.current?.({ action: 'allow' });
              toolApprovalResolverRef.current = null;
              setToolApproval(null);
              setOverlay(null);
            }}
            onCancel={() => {
              toolApprovalResolverRef.current?.({
                action: 'deny',
                reason: 'user denied approval'
              });
              toolApprovalResolverRef.current = null;
              setToolApproval(null);
              setOverlay(null);
            }}
          />
        ) : null}
        {/* Structured-question option picker — pops when the model
            emits an `<atlas:question>` block. The user picks one of
            the suggestions (or "type freeform answer"); the choice
            is sent as the next user turn so the model continues. */}
        {overlay === 'option-picker' && interactionRequest ? (
          <Picker
            title={interactionRequest.prompt}
            options={(() => {
              const opts: PickerOption[] = interactionRequest.options.map((o) => ({
                value: o.value,
                label: o.label
              }));
              if (interactionRequest.allowFreeform) {
                opts.push({
                  value: '__freeform__',
                  label: '✎ Type freeform answer…',
                  description: 'open a text box to write your own answer'
                });
              }
              return opts;
            })()}
            hint="↑/↓ navigate · ↵ choose · Esc dismiss"
            onChoose={(v) => {
              if (v === '__freeform__') {
                setOverlay('option-freeform');
                return;
              }
              setOverlay(null);
              setInteractionRequest(null);
              setInput(v);
              const ta = composerRef.current as unknown as {
                setText?: (s: string) => void;
              } | null;
              ta?.setText?.(v);
              void submit();
            }}
            onCancel={() => {
              setOverlay(null);
              setInteractionRequest(null);
            }}
          />
        ) : null}
        {overlay === 'option-freeform' && interactionRequest ? (
          <KeyEntry
            title={interactionRequest.prompt}
            help="Type your answer. ↵ to send · Esc to cancel."
            placeholder="your answer…"
            onSubmit={(v) => {
              const value = v.trim();
              setOverlay(null);
              setInteractionRequest(null);
              if (!value) return;
              setInput(value);
              const ta = composerRef.current as unknown as {
                setText?: (s: string) => void;
              } | null;
              ta?.setText?.(value);
              void submit();
            }}
            onCancel={() => {
              setOverlay(null);
              setInteractionRequest(null);
            }}
          />
        ) : null}
        {overlay === 'config' ? (
          <Picker
            title="⚙  Atlas setup — choose what to configure"
            descriptionColor={palette.success}
            options={(() => {
              const cfg = props.config;
              const hasOR = Boolean(props.providers?.openrouter);
              const hasAnthKey = Boolean(cfg?.providers.anthropic.apiKey);
              const hasClaudeCode = Boolean(props.providers?.anthropic) && !hasAnthKey;
              const hasChatGpt = Boolean(props.providers?.['openai-codex']);
              const hasLocal = Boolean(props.providers?.local);
              const hasGithub = Boolean(cfg?.github?.token);
              const mcpCount = cfg?.mcp?.servers?.length ?? 0;
              const atlasSpec = ATLAS_POWER_MODE_SPECS[activeAtlasMode];
              // Only show a description when the slot is connected;
              // disconnected items render with no badge so the green
              // ● connected reads cleanly. Mirrors the Ink TUI's
              // /config palette (App.tsx — `tag()` returns ''  for
              // disconnected).
              const tag = (on: boolean, note = 'connected'): string =>
                on ? `● ${note}` : '';
              const opts: PickerOption[] = [
                {
                  value: 'openrouter',
                  label: 'OpenRouter API key  (sk-or-…)',
                  description: tag(hasOR)
                },
                {
                  value: 'anthropic',
                  label: 'Anthropic API key   (sk-ant-…)',
                  description: tag(hasAnthKey)
                },
                {
                  value: 'claude-code',
                  label: 'Claude Code OAuth   (auto-detected)',
                  description: tag(hasClaudeCode, 'detected')
                },
                {
                  value: 'chatgpt',
                  label: 'Sign in with ChatGPT (browser, Codex)',
                  description: tag(hasChatGpt)
                },
                {
                  value: 'atlas-power',
                  label: 'Atlas power mode  (Full / Smart)',
                  description: `● ${atlasSpec.label} · ${atlasSpec.costEstimate}`
                },
                {
                  value: 'local',
                  label: 'Local models      (Ollama, LM Studio, vLLM)',
                  description: tag(hasLocal, 'detected')
                },
                {
                  value: 'github',
                  label: 'GitHub token        (gh integration)',
                  description: tag(hasGithub)
                },
                {
                  value: 'mcp',
                  label: 'MCP server          (model context protocol)',
                  description: mcpCount > 0 ? `● ${mcpCount} configured` : ''
                },
                {
                  value: 'ship',
                  label: '/ship merge defaults (auto-resolve, prompt-on-conflict)',
                  description: cfg?.ship?.autoResolve
                    ? `● ${cfg.ship.autoResolve}${cfg.ship.promptOnConflict ? ', prompt' : ''}`
                    : ''
                }
              ];
              return opts;
            })()}
            hint="↑/↓ navigate · ↵ choose · Esc cancel"
            onChoose={(v) => {
              setConfigError(null);
              if (v === 'openrouter') {
                const hasOR = Boolean(props.providers?.openrouter);
                setOverlay(hasOR ? 'config-action-openrouter' : 'config-key-openrouter');
                return;
              }
              if (v === 'anthropic') {
                const hasAnthKey = Boolean(props.config?.providers.anthropic.apiKey);
                setOverlay(hasAnthKey ? 'config-action-anthropic' : 'config-key-anthropic');
                return;
              }
              if (v === 'claude-code') {
                setInfoOverlay({
                  title: 'Claude Code OAuth',
                  body: props.providers?.anthropic && !props.config?.providers.anthropic.apiKey
                    ? 'Claude Code OAuth detected.\n\nAtlas uses it automatically when the Anthropic\nprovider is selected and no API key is configured.'
                    : 'No Claude Code credentials found.\n\nInstall Claude Code, sign in, then re-open this menu.\nAtlas reads ~/.claude/credentials.json on each launch.',
                  tone: 'info'
                });
                setOverlay('config-info');
                return;
              }
              if (v === 'chatgpt') {
                setInfoOverlay({
                  title: 'Sign in with ChatGPT',
                  body: 'Browser-based sign-in is available from the classic interface for now.\n\nRun `atlas chat --ui=ink`, open /config, and complete ChatGPT sign-in there. The saved tokens in ~/.atlas/config.yaml will work here after restart.',
                  tone: 'warn'
                });
                setOverlay('config-info');
                return;
              }
              if (v === 'atlas-power') {
                setOverlay('config-atlas-power');
                return;
              }
              if (v === 'local') {
                setOverlay('config-local');
                return;
              }
              if (v === 'github') {
                setInfoOverlay({
                  title: 'GitHub token',
                  body: 'Use the gh CLI to authenticate:\n\n  1. Install:  brew install gh   (or apt/dnf/winget)\n  2. Sign in:  gh auth login\n\nAtlas picks up the token from `gh auth token` when\nthe GitHub tools are invoked.',
                  tone: 'info'
                });
                setOverlay('config-info');
                return;
              }
              if (v === 'mcp') {
                setOverlay('config-mcp');
                return;
              }
              if (v === 'ship') {
                setOverlay('config-ship');
                return;
              }
            }}
            onCancel={() => setOverlay(null)}
          />
        ) : null}
        {overlay === 'config-atlas-power' ? (() => {
          const currentMode: AtlasPowerMode = activeAtlasMode;
          const modeInfo = ATLAS_POWER_MODE_ORDER.map((mode) => {
            const spec = ATLAS_POWER_MODE_SPECS[mode];
            return `${spec.label}
  Cost: ${spec.costEstimate}
  Pros: ${spec.pros}
  Cons: ${spec.cons}`;
          }).join('\n\n');
          return (
            <Picker
              title="⚙  Atlas power mode"
              descriptionColor={palette.success}
              options={[
                ...ATLAS_POWER_MODE_ORDER.map((mode): PickerOption => {
                  const spec = ATLAS_POWER_MODE_SPECS[mode];
                  return {
                    value: `mode:${mode}`,
                    label: `${currentMode === mode ? '[ACTIVE] ' : '[ ] '}${spec.label}`,
                    description: `cost: ${spec.costEstimate}; pro: ${spec.pros}; con: ${spec.cons}`
                  };
                }),
                {
                  value: 'info',
                  label: 'mode specs and cache guidance',
                  description: 'use cache: yes models for cheaper repeated Full Atlas prompts'
                },
                { value: '__cancel', label: 'back', description: '' }
              ]}
              hint="↵ select · Esc back"
              onChoose={(action) => {
                if (action === '__cancel') {
                  setOverlay('config');
                  return;
                }
                if (action === 'info') {
                  setInfoOverlay({
                    title: 'Atlas power modes',
                    body: `${modeInfo}

Model picker cache labels:
  cache: yes (cheaper)  provider reports or strongly supports prompt caching
  cache: unknown        provider route may vary
  cache: no             repeated prompt prefixes are billed normally

Config file: ~/.atlas/config.yaml
  atlasMode: ${currentMode}  # full | smart`,
                    tone: 'info'
                  });
                  setOverlay('config-info');
                  return;
                }
                if (action.startsWith('mode:')) {
                  const mode = action.slice('mode:'.length);
                  if (!isAtlasPowerMode(mode)) return;
                  void (async () => {
                    const current = props.config;
                    if (!current) {
                      pushItem('error', 'no config loaded — cannot change Atlas power mode');
                      return;
                    }
                    const next: AtlasConfig = { ...current, atlasMode: mode };
                    const r = await saveConfig(next);
                    if (!r.ok) {
                      pushItem('error', `save failed: ${r.error.message}`);
                      return;
                    }
                    setActiveAtlasMode(mode);
                    pushItem(
                      'system',
                      `✓ Atlas power mode set to ${ATLAS_POWER_MODE_SPECS[mode].label} — saved to ~/.atlas/config.yaml`
                    );
                    setOverlay(null);
                  })();
                }
              }}
              onCancel={() => setOverlay('config')}
            />
          );
        })() : null}
        {overlay === 'config-action-openrouter' ? (
          <Picker
            title="⚙  OpenRouter — already connected"
            descriptionColor={palette.success}
            options={[
              {
                value: 'replace',
                label: 'set new key',
                description: 'replace the saved OpenRouter key'
              },
              {
                value: 'remove',
                label: 'disconnect / remove key',
                description: 'wipe the saved key from ~/.atlas/config.yaml'
              },
              { value: '__cancel', label: 'cancel', description: '' }
            ]}
            hint="↵ apply · Esc back"
            onChoose={(action) => {
              if (action === '__cancel') {
                setOverlay('config');
                return;
              }
              if (action === 'replace') {
                setOverlay('config-key-openrouter');
                return;
              }
              if (action === 'remove') {
                setOverlay(null);
                void (async () => {
                  const r = await removeProviderKey('openrouter', props.config);
                  if (!r.ok) {
                    pushItem('error', `disconnect failed: ${r.error}`);
                    return;
                  }
                  pushItem(
                    'system',
                    `✓ removed OpenRouter key from ${r.path}. Restart atlas to apply.`
                  );
                })();
                return;
              }
            }}
            onCancel={() => setOverlay('config')}
          />
        ) : null}
        {overlay === 'config-local' ? (() => {
          const detected = Boolean(props.providers?.local);
          const localCfg = props.config?.providers?.local;
          const currentToolMode: LocalProviderToolMode =
            localCfg?.toolMode ?? (localCfg?.liteMode === false ? 'full' : 'lite');
          const currentTimeout = localCfg?.requestTimeoutMs ?? 300_000;
          const modeInfo = LOCAL_TOOL_MODE_ORDER.map((mode) => {
            const spec = LOCAL_TOOL_MODE_SPECS[mode];
            return `${spec.label}
  Specs: ${spec.requirements}
  Pros: ${spec.pros}
  Cons: ${spec.cons}`;
          }).join('\n\n');
          return (
            <Picker
              title={`⚙  Local models (Ollama / LM Studio)${detected ? '  ✓ connected' : '  ✗ not detected'}`}
              descriptionColor={detected ? palette.success : palette.warning}
              options={[
                ...LOCAL_TOOL_MODE_ORDER.map((mode): PickerOption => {
                  const spec = LOCAL_TOOL_MODE_SPECS[mode];
                  return {
                    value: `mode:${mode}`,
                    label: `${currentToolMode === mode ? '[ACTIVE] ' : '[ ] '}${spec.label}`,
                    description: `${spec.requirements}; pro: ${spec.pros}; con: ${spec.cons}`
                  };
                }),
                {
                  value: 'info',
                  label: 'mode specs and setup info',
                  description: detected
                    ? `connected at ${localCfg?.baseUrl ?? 'http://localhost:11434/v1'} · ${currentToolMode} · timeout ${Math.round(currentTimeout / 1000)}s`
                    : 'install Ollama or point baseUrl at your local server'
                },
                { value: '__cancel', label: 'back', description: '' }
              ]}
              hint="↵ select · Esc back"
              onChoose={(action) => {
                if (action === '__cancel') {
                  setOverlay('config');
                  return;
                }
                if (action === 'info') {
                  setInfoOverlay({
                    title: 'Local models — setup',
                    body: detected
                      ? `Connected at ${localCfg?.baseUrl ?? 'http://localhost:11434/v1'}.

Pull models with:
  ollama pull qwen2.5-coder:1.5b   (fast on low-RAM)
  ollama pull qwen2.5-coder:7b
  ollama pull deepseek-r1:7b

Modes:
${modeInfo}

Hybrid tool allowlist:
  ${LOCAL_HYBRID_TOOL_NAMES.join(', ')}

Config file: ~/.atlas/config.yaml
  providers:
    local:
      toolMode: ${currentToolMode}  # lite | hybrid | full
      requestTimeoutMs: 300000`
                      : 'No local server at http://localhost:11434/v1.\n\nInstall Ollama: https://ollama.com/download\nThen pull a model and restart Atlas:\n  ollama pull qwen2.5-coder:1.5b\n\nAtlas auto-detects on startup — no config edit needed.',
                    tone: detected ? 'info' : 'warn'
                  });
                  setOverlay('config-info');
                  return;
                }
                if (action.startsWith('mode:')) {
                  const mode = action.slice('mode:'.length);
                  if (!isLocalProviderToolMode(mode)) return;
                  void (async () => {
                    const current = props.config;
                    if (!current) {
                      pushItem('error', 'no config loaded — cannot change local mode');
                      return;
                    }
                    const next: AtlasConfig = {
                      ...current,
                      providers: {
                        ...current.providers,
                        local: {
                          ...current.providers.local,
                          toolMode: mode,
                          liteMode: mode === 'lite'
                        }
                      }
                    };
                    const r = await saveConfig(next);
                    if (!r.ok) {
                      pushItem('error', `save failed: ${r.error.message}`);
                      return;
                    }
                    pushItem(
                      'system',
                      `✓ local tool mode set to ${mode} — restart Atlas to apply (saved to ~/.atlas/config.yaml)`
                    );
                    setOverlay(null);
                  })();
                  return;
                }
              }}
              onCancel={() => setOverlay('config')}
            />
          );
        })() : null}
        {overlay === 'config-action-anthropic' ? (
          <Picker
            title="⚙  Anthropic — already connected"
            descriptionColor={palette.success}
            options={[
              {
                value: 'replace',
                label: 'set new key',
                description: 'replace the saved Anthropic key'
              },
              {
                value: 'remove',
                label: 'disconnect / remove key',
                description: 'wipe the saved key (falls back to Claude Code OAuth if available)'
              },
              { value: '__cancel', label: 'cancel', description: '' }
            ]}
            hint="↵ apply · Esc back"
            onChoose={(action) => {
              if (action === '__cancel') {
                setOverlay('config');
                return;
              }
              if (action === 'replace') {
                setOverlay('config-key-anthropic');
                return;
              }
              if (action === 'remove') {
                setOverlay(null);
                void (async () => {
                  const r = await removeProviderKey('anthropic', props.config);
                  if (!r.ok) {
                    pushItem('error', `disconnect failed: ${r.error}`);
                    return;
                  }
                  pushItem(
                    'system',
                    `✓ removed Anthropic key from ${r.path}. Restart atlas to apply.`
                  );
                })();
                return;
              }
            }}
            onCancel={() => setOverlay('config')}
          />
        ) : null}
        {overlay === 'config-key-openrouter' ? (
          <KeyEntry
            title="⚙  OpenRouter API key"
            help={
              'Paste your key. Saved to ~/.atlas/config.yaml.\n' +
              'Get a key at https://openrouter.ai/keys\n' +
              'Tip: comma-separated keys = primary + fallback rotation on 401/429.'
            }
            placeholder="sk-or-…"
            mask
            {...(configError ? { errorMessage: configError } : {})}
            onSubmit={(v) => {
              void (async () => {
                const result = await saveProviderKey('openrouter', v, props.config);
                if (!result.ok) {
                  setConfigError(result.error);
                  return;
                }
                setConfigError(null);
                pushItem(
                  'system',
                  `✓ saved OpenRouter key to ${result.path}. Restart atlas to activate.`
                );
                setOverlay(null);
              })();
            }}
            onCancel={() => setOverlay(null)}
          />
        ) : null}
        {overlay === 'config-key-anthropic' ? (
          <KeyEntry
            title="⚙  Anthropic API key"
            help={
              'Paste your key. Saved to ~/.atlas/config.yaml.\n' +
              'Get a key at https://console.anthropic.com/settings/keys'
            }
            placeholder="sk-ant-…"
            mask
            {...(configError ? { errorMessage: configError } : {})}
            onSubmit={(v) => {
              void (async () => {
                const result = await saveProviderKey('anthropic', v, props.config);
                if (!result.ok) {
                  setConfigError(result.error);
                  return;
                }
                setConfigError(null);
                pushItem(
                  'system',
                  `✓ saved Anthropic key to ${result.path}. Restart atlas to activate.`
                );
                setOverlay(null);
              })();
            }}
            onCancel={() => setOverlay(null)}
          />
        ) : null}
        {overlay === 'config-info' && infoOverlay ? (
          <InfoOverlay
            title={infoOverlay.title}
            body={infoOverlay.body}
            {...(infoOverlay.tone ? { tone: infoOverlay.tone } : {})}
            onClose={() => {
              setOverlay(null);
              setInfoOverlay(null);
            }}
          />
        ) : null}
        {overlay === 'config-mcp' ? (
          <Picker
            title="MCP servers — pick one to install or inspect"
            descriptionColor={palette.success}
            options={(() => {
              const configured = new Set(
                (props.config?.mcp?.servers ?? []).map((s) => s.name)
              );
              const rows: PickerOption[] = MCP_CATALOG.map((s) => ({
                value: s.id,
                label: `${s.id.padEnd(12)} (${s.pricing})  ${s.summary}`,
                description: configured.has(s.id) ? '● configured' : ''
              }));
              rows.push({
                value: '__custom__',
                label: '+ custom server  (not in this list)',
                description: 'manual ~/.atlas/config.yaml instructions'
              });
              return rows;
            })()}
            hint="↑/↓ navigate · ↵ choose · Esc back"
            onChoose={(id) => {
              if (id === '__custom__') {
                setOverlay('config-mcp-custom');
                return;
              }
              const sug = findSuggestion(id);
              if (!sug) {
                setOverlay(null);
                return;
              }
              setSelectedMcp(id);
              setOverlay('config-mcp-action');
            }}
            onCancel={() => setOverlay('config')}
          />
        ) : null}
        {overlay === 'config-mcp-action' && selectedMcp ? (() => {
          const sug = findSuggestion(selectedMcp);
          if (!sug) { setOverlay('config-mcp'); return null; }
          const alreadyConfigured = (props.config?.mcp?.servers ?? []).some(
            (s) => s.name === sug.name
          );
          const opts: PickerOption[] = [];
          if (!alreadyConfigured) {
            opts.push({
              value: 'add',
              label: `Add ${sug.name} to ~/.atlas/config.yaml`,
              description:
                sug.transport === 'http'
                  ? 'http transport · ' + (sug.env.length > 0
                      ? `prompts for ${sug.env.length} secret(s)`
                      : 'no secrets needed')
                  : 'stdio transport · ' + (sug.env.length > 0
                      ? `prompts for ${sug.env.length} secret(s)`
                      : 'no secrets needed')
            });
          }
          opts.push({ value: 'details', label: 'Show details', description: '' });
          opts.push({ value: 'back', label: 'Back to catalog', description: '' });
          return (
            <Picker
              title={`MCP · ${sug.name}${alreadyConfigured ? ' (already configured)' : ''}`}
              descriptionColor={palette.success}
              options={opts}
              hint="↵ pick · Esc cancel"
              onChoose={(v) => {
                if (v === 'back') { setOverlay('config-mcp'); return; }
                if (v === 'details') {
                  const lines: string[] = [
                    sug.summary,
                    '',
                    `transport: ${sug.transport}`,
                    `pricing:   ${sug.pricing}`
                  ];
                  if (sug.transport === 'http') {
                    lines.push(`url:       ${sug.url}`);
                  } else {
                    lines.push(`command:   ${[sug.command, ...sug.args].join(' ')}`);
                    lines.push(`needs:     ${sug.prerequisite.bin} on PATH`);
                  }
                  if (sug.env.length > 0) {
                    lines.push('', 'env vars:');
                    for (const e of sug.env) {
                      lines.push(
                        `  ${e.key}${e.required ? ' (required)' : ' (optional)'}`
                      );
                    }
                  }
                  lines.push('', `docs: ${sug.docs}`);
                  if (sug.transport === 'stdio' && sug.authMethods?.includes('oauth-gh')) {
                    lines.push(
                      '',
                      'Tip: this server supports OAuth via the `gh` CLI.',
                      'For the guided OAuth flow, run `atlas chat --ui=ink`',
                      'and open /config. Otherwise paste a PAT below.'
                    );
                  }
                  setInfoOverlay({
                    title: `MCP · ${sug.name}`,
                    body: lines.join('\n'),
                    tone: sug.pricing === 'paid' ? 'warn' : 'info'
                  });
                  setOverlay('config-info');
                  return;
                }
                if (v === 'add') {
                  setMcpAddState({ id: sug.id, envIndex: 0, collected: {} });
                  if (sug.env.length === 0) {
                    setOverlay('config-mcp-add-confirm');
                  } else {
                    setOverlay('config-mcp-add-env');
                  }
                }
              }}
              onCancel={() => setOverlay('config-mcp')}
            />
          );
        })() : null}
        {overlay === 'config-mcp-custom' ? (
          <InfoOverlay
            title="Add a custom MCP server"
            body={[
              'The guided custom-server wizard is available from the',
              'classic interface for now: `atlas chat --ui=ink`, then',
              '/config -> MCP server -> custom.',
              '',
              'Manual setup:',
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
            ].join('\n')}
            tone="info"
            onClose={() => setOverlay('config-mcp')}
          />
        ) : null}
        {overlay === 'config-mcp-add-env' && mcpAddState ? (() => {
          const sug = findSuggestion(mcpAddState.id);
          const spec = sug?.env[mcpAddState.envIndex];
          if (!sug || !spec) {
            setOverlay('config-mcp-add-confirm');
            return null;
          }
          const friendly: Record<string, { title: string; helper: string }> = {
            GITHUB_PERSONAL_ACCESS_TOKEN: {
              title: 'Paste your GitHub Personal Access Token',
              helper:
                'Create one at https://github.com/settings/tokens (classic\nor fine-grained). At minimum `repo` for private repos, or\n`public_repo` for public-only.'
            },
            HIGGSFIELD_API_KEY: {
              title: 'Paste your Higgsfield API key',
              helper: 'Grab it from https://higgsfield.ai/mcp → your account.'
            },
            FIGMA_API_TOKEN: {
              title: 'Paste your Figma personal access token',
              helper:
                'Figma → Settings → Account → Personal access tokens.'
            }
          };
          const f = friendly[spec.key];
          const title = f
            ? `${f.title}${spec.required ? '' : ' (optional)'}`
            : `${sug.name} → ${spec.key}${spec.required ? ' (required)' : ' (optional)'}`;
          const help = (f?.helper ?? spec.description) +
            `\n\nServer ${sug.name} · env ${mcpAddState.envIndex + 1} of ${sug.env.length}` +
            (spec.required ? '' : '\nLeave blank + press ↵ to skip.');
          return (
            <KeyEntry
              key={`mcpenv:${mcpAddState.id}:${mcpAddState.envIndex}`}
              title={title}
              help={help}
              placeholder={spec.placeholder ?? ''}
              mask
              onSubmit={(v) => {
                const value = v.trim();
                const next: Record<string, string> = { ...mcpAddState.collected };
                if (value.length > 0) next[spec.key] = value;
                else if (spec.required) {
                  pushItem('error', `${spec.key} is required`);
                  return;
                }
                const nextIdx = mcpAddState.envIndex + 1;
                setMcpAddState({
                  id: mcpAddState.id,
                  envIndex: nextIdx,
                  collected: next
                });
                if (nextIdx >= sug.env.length) {
                  setOverlay('config-mcp-add-confirm');
                } else {
                  // stay on the env overlay; React will pick up the
                  // bumped envIndex and render the next spec.
                }
              }}
              onCancel={() => {
                setMcpAddState(null);
                setOverlay('config-mcp');
              }}
            />
          );
        })() : null}
        {overlay === 'config-mcp-add-confirm' && mcpAddState ? (() => {
          const sug = findSuggestion(mcpAddState.id);
          if (!sug) {
            setMcpAddState(null);
            setOverlay('config-mcp');
            return null;
          }
          const summary: string[] = [];
          if (sug.transport === 'http') {
            summary.push(`url: ${sug.url}`);
            const hdrKeys = Object.keys(sug.headerTemplate);
            if (hdrKeys.length > 0) summary.push(`headers: ${hdrKeys.join(', ')}`);
          } else {
            summary.push(`command: ${[sug.command, ...sug.args].join(' ')}`);
          }
          const collectedKeys = Object.keys(mcpAddState.collected);
          if (collectedKeys.length > 0) {
            summary.push(`secrets: ${collectedKeys.join(', ')}`);
          }
          return (
            <Picker
              title={`Add MCP server '${sug.name}'? · ${summary.join(' · ')}`}
              options={[
                { value: 'no', label: 'No — cancel', description: '' },
                {
                  value: 'yes',
                  label: 'Yes — save to ~/.atlas/config.yaml',
                  description: ''
                }
              ]}
              hint="↵ confirm · Esc cancel"
              onChoose={(choice) => {
                if (choice !== 'yes') {
                  setMcpAddState(null);
                  setOverlay('config-mcp');
                  return;
                }
                const baseCfg = props.config;
                if (!baseCfg) {
                  pushItem('error', 'no config — cannot save');
                  setMcpAddState(null);
                  setOverlay(null);
                  return;
                }
                const entry: McpServerConfig = sug.transport === 'http'
                  ? {
                      name: sug.name,
                      transport: 'http',
                      url: sug.url,
                      args: [],
                      env: {},
                      headers: Object.fromEntries(
                        Object.entries(sug.headerTemplate).map(([k, v]) => [
                          k,
                          v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) =>
                            mcpAddState.collected[key] ?? ''
                          )
                        ])
                      ),
                      enabled: true
                    }
                  : {
                      name: sug.name,
                      transport: 'stdio',
                      command: sug.command,
                      args: [...sug.args],
                      env: { ...mcpAddState.collected },
                      headers: {},
                      enabled: true
                    };
                const next: AtlasConfig = {
                  ...baseCfg,
                  mcp: {
                    ...baseCfg.mcp,
                    servers: [
                      ...(baseCfg.mcp?.servers ?? []).filter((s) => s.name !== entry.name),
                      entry
                    ]
                  }
                };
                void saveConfig(next).then((r) => {
                  if (!r.ok) {
                    pushItem('error', `save failed: ${r.error.message}`);
                  } else {
                    pushItem(
                      'system',
                      `✓ added MCP server '${sug.name}'. Restart atlas to spawn it.`
                    );
                  }
                });
                setMcpAddState(null);
                setOverlay(null);
              }}
              onCancel={() => {
                setMcpAddState(null);
                setOverlay('config-mcp');
              }}
            />
          );
        })() : null}
        {overlay === 'config-ship' ? (() => {
          const cfg = props.config;
          const cur = cfg?.ship?.autoResolve ?? shipAutoResolveRef.current;
          const prompt = cfg?.ship?.promptOnConflict ?? shipPromptOnConflictRef.current;
          const opts: PickerOption[] = [
            {
              value: 'autoresolve:abort',
              label: `auto-resolve = abort   ${cur === 'abort' ? '●' : ' '}`,
              description: 'stop on conflict, print a manual-resolution recipe'
            },
            {
              value: 'autoresolve:ours',
              label: `auto-resolve = ours    ${cur === 'ours' ? '●' : ' '}`,
              description: 'keep the branch you are ON for every conflict'
            },
            {
              value: 'autoresolve:theirs',
              label: `auto-resolve = theirs  ${cur === 'theirs' ? '●' : ' '}`,
              description: 'keep the branch being merged IN for every conflict'
            },
            {
              value: 'autoresolve:ai',
              label: `auto-resolve = ai      ${cur === 'ai' ? '●' : ' '}`,
              description: 'let an AI agent resolve the markers (review!)'
            },
            {
              value: 'prompt:toggle',
              label: `prompt-on-conflict     ${prompt ? '[x]' : '[ ]'}`,
              description: prompt
                ? 'currently ON — atlas will pop the strategy picker on every conflict'
                : 'currently OFF — atlas will use the auto-resolve default silently'
            }
          ];
          return (
            <Picker
              title="/ship merge defaults"
              descriptionColor={palette.success}
              options={opts}
              hint="↑/↓ navigate · ↵ apply · Esc back"
              onChoose={(v) => {
                const baseCfg = cfg;
                if (!baseCfg) {
                  pushItem('error', 'no config — cannot persist');
                  return;
                }
                let next: AtlasConfig = baseCfg;
                if (v.startsWith('autoresolve:')) {
                  const strat = v.split(':')[1] as 'abort' | 'ours' | 'theirs' | 'ai';
                  shipAutoResolveRef.current = strat;
                  next = {
                    ...baseCfg,
                    ship: { ...baseCfg.ship, autoResolve: strat }
                  };
                  pushItem('system', `ship.autoResolve → ${strat}`);
                } else if (v === 'prompt:toggle') {
                  const nextPrompt = !prompt;
                  shipPromptOnConflictRef.current = nextPrompt;
                  next = {
                    ...baseCfg,
                    ship: { ...baseCfg.ship, promptOnConflict: nextPrompt }
                  };
                  pushItem(
                    'system',
                    `ship.promptOnConflict → ${nextPrompt ? 'on' : 'off'}`
                  );
                }
                void saveConfig(next).then((r) => {
                  if (!r.ok) pushItem('error', `save failed: ${r.error.message}`);
                });
                // Stay on the overlay so the user can flip multiple
                // settings in a row without bouncing back to the
                // config menu. Esc takes them back manually.
              }}
              onCancel={() => setOverlay('config')}
            />
          );
        })() : null}
        {overlay === 'mcps-manage' ? (
          <Picker
            title="MCP servers — pick one to manage"
            descriptionColor={palette.success}
            options={(() => {
              const configured = props.config?.mcp?.servers ?? [];
              const running = new Set(
                (props.mcpStatus?.running ?? []).map((r) => r.name)
              );
              const failed = new Map(
                (props.mcpStatus?.failed ?? []).map((f) => [f.name, f.error])
              );
              const configuredOpts = configured.map((s) => {
                const isCatalog = MCP_CATALOG.some((c) => c.id === s.name);
                let badge = '';
                if (s.enabled === false) badge = '○ disabled';
                else if (failed.has(s.name)) badge = '✗ failed';
                else if (running.has(s.name)) badge = '● running';
                else badge = '◐ ready';
                const lock = isCatalog ? ' (default)' : '';
                return {
                  value: s.name,
                  label: `${s.name.padEnd(18)}${lock}`,
                  description: badge
                };
              });
              // Catalog entries that aren't configured — surfaced
              // as "+ add filesystem" rows for one-click access to
              // the same info-card the catalog overlay shows.
              const seen = new Set(configured.map((s) => s.name));
              const catalogOpts = MCP_CATALOG.filter((c) => !seen.has(c.id)).map(
                (c) => ({
                  value: `__add_${c.id}`,
                  label: `+ add ${c.id.padEnd(14)} (${c.pricing})`,
                  description: c.summary
                })
              );
              const browseAll = [
                { value: '__browse__', label: '↗ browse full catalog', description: '' }
              ];
              return [...configuredOpts, ...catalogOpts, ...browseAll];
            })()}
            hint="↵ pick · Esc back"
            onChoose={(value) => {
              if (value === '__browse__') {
                setOverlay('config-mcp');
                return;
              }
              if (value.startsWith('__add_')) {
                const id = value.slice('__add_'.length);
                const entry = MCP_CATALOG.find((s) => s.id === id);
                if (entry) {
                  const lines: string[] = [
                    entry.summary,
                    '',
                    `transport: ${entry.transport}`
                  ];
                  if (entry.url) lines.push(`url:       ${entry.url}`);
                  if (entry.envKey) {
                    lines.push('', `env var:   ${entry.envKey}=${entry.envPlaceholder ?? '…'}`);
                  }
                  lines.push(
                    '',
                    'Add under `mcp.servers` in ~/.atlas/config.yaml.',
                    'Then re-launch Atlas.'
                  );
                  if (entry.docs) lines.push('', `docs: ${entry.docs}`);
                  setInfoOverlay({
                    title: `MCP · ${entry.id}`,
                    body: lines.join('\n'),
                    tone: entry.pricing === 'paid' ? 'warn' : 'info'
                  });
                  setOverlay('config-info');
                }
                return;
              }
              setSelectedMcp(value);
              setOverlay('mcps-actions');
            }}
            onCancel={() => setOverlay(null)}
          />
        ) : null}
        {overlay === 'mcps-actions' && selectedMcp ? (
          <Picker
            title={`MCP · ${selectedMcp}`}
            options={(() => {
              const cur = (props.config?.mcp?.servers ?? []).find(
                (s) => s.name === selectedMcp
              );
              const isCatalog = MCP_CATALOG.some((c) => c.id === selectedMcp);
              const enabled = cur?.enabled !== false;
              const opts: PickerOption[] = [
                enabled
                  ? { value: 'disable', label: 'disable', description: 'turn off (kept in config)' }
                  : { value: 'enable', label: 'enable', description: 'turn back on' }
              ];
              if (!isCatalog) {
                opts.push({
                  value: 'remove',
                  label: 'remove',
                  description: 'strip from config'
                });
              } else {
                opts.push({
                  value: '__locked',
                  label: '(remove disabled — default MCP)',
                  description: 'use disable to turn off'
                });
              }
              opts.push({ value: '__cancel', label: 'cancel', description: '' });
              return opts;
            })()}
            hint="↵ apply · Esc back"
            onChoose={(action) => {
              if (action === '__cancel' || action === '__locked') {
                setOverlay('mcps-manage');
                return;
              }
              const baseCfg = props.config;
              if (!baseCfg) {
                pushItem('error', 'no config loaded — cannot persist change');
                setOverlay(null);
                return;
              }
              const servers = baseCfg.mcp?.servers ?? [];
              const idx = servers.findIndex((s) => s.name === selectedMcp);
              if (idx < 0) {
                setOverlay('mcps-manage');
                return;
              }
              let nextServers = servers;
              let msg = '';
              if (action === 'remove') {
                if (MCP_CATALOG.some((c) => c.id === selectedMcp)) {
                  pushItem('error', `'${selectedMcp}' is a default MCP — disable instead.`);
                  setOverlay('mcps-manage');
                  return;
                }
                nextServers = servers.filter((s) => s.name !== selectedMcp);
                msg = `removed '${selectedMcp}' — restart atlas to apply.`;
              } else {
                const enable = action === 'enable';
                nextServers = servers.map((s, i) =>
                  i === idx ? { ...s, enabled: enable } : s
                );
                msg = `'${selectedMcp}' ${enable ? 'enabled' : 'disabled'} — restart atlas to apply.`;
              }
              const next: AtlasConfig = {
                ...baseCfg,
                mcp: { ...(baseCfg.mcp ?? { servers: [] }), servers: nextServers }
              };
              void saveConfig(next).then((r) => {
                if (!r.ok) pushItem('error', `save failed: ${r.error.message}`);
                else pushItem('system', msg);
              });
              setOverlay(null);
              setSelectedMcp(null);
            }}
            onCancel={() => setOverlay('mcps-manage')}
          />
        ) : null}
        {overlay === 'sessions-list' ? (
          <Picker
            title={`sessions (${sessionList.length})`}
            options={(() => {
              const opts: PickerOption[] = sessionList.slice(0, 50).map((s) => {
                const when =
                  typeof s.updatedAt === 'string'
                    ? s.updatedAt.slice(0, 19).replace('T', ' ')
                    : '';
                return {
                  value: s.id,
                  label: `${(s.title ?? s.id).padEnd(28)}`,
                  description: when
                };
              });
              opts.push({
                value: '__new__',
                label: '+ new session',
                description: 'clear transcript and start fresh'
              });
              opts.push({
                value: '__delete_select__',
                label: 'select sessions to delete',
                description: 'mark multiple saved sessions, then delete together'
              });
              opts.push({
                value: '__delete_all__',
                label: 'delete all sessions',
                description: `remove all ${sessionList.length} saved session${sessionList.length === 1 ? '' : 's'}`
              });
              return opts;
            })()}
            hint="↵ pick · Esc back"
            onChoose={(value) => {
              if (value === '__new__') {
                setTranscript([]);
                messagesRef.current = [];
                sessionRef.current = null;
                setSessionId(null);
                setSessionTitle(null);
                transcriptKey.current += 1;
                pushItem('system', '✦ new session — transcript cleared.');
                setOverlay(null);
                return;
              }
              if (value === '__delete_select__') {
                setMarkedSessionIds([]);
                setPendingDeleteSessionIds([]);
                setOverlay('sessions-delete-select');
                return;
              }
              if (value === '__delete_all__') {
                setPendingDeleteSessionIds(sessionList.map((s) => s.id));
                setOverlay('sessions-delete-confirm');
                return;
              }
              setSelectedSession(value);
              setOverlay('sessions-actions');
            }}
            onCancel={() => setOverlay(null)}
          />
        ) : null}
        {overlay === 'sessions-actions' && selectedSession ? (
          <Picker
            title={`session · ${(() => {
              const e = sessionList.find((s) => s.id === selectedSession);
              return e?.title ? `${e.title} (${selectedSession.slice(0, 8)})` : selectedSession;
            })()}`}
            options={[
              { value: 'resume', label: 'resume', description: 'load this session' },
              { value: 'rename', label: 'rename', description: 'edit the session title' },
              { value: 'delete', label: 'delete', description: 'remove from disk' },
              { value: '__cancel', label: 'cancel', description: '' }
            ]}
            hint="↵ apply · Esc back"
            onChoose={(action) => {
              const store = props.sessionStore;
              const target = selectedSession;
              if (!store || !target) {
                setOverlay(null);
                return;
              }
              if (action === '__cancel') {
                setOverlay('sessions-list');
                return;
              }
              if (action === 'resume') {
                setOverlay(null);
                void (async () => {
                  try {
                    const r = await store.load(target);
                    if (!r.ok) {
                      pushItem('error', `resume failed: ${r.error.message}`);
                      return;
                    }
                    const items = r.value.messages.map((m, i) => ({
                      kind:
                        m.role === 'user'
                          ? ('user' as const)
                          : m.role === 'assistant'
                            ? ('assistant' as const)
                            : ('system' as const),
                      text:
                        m.role === 'assistant'
                          ? renderVisibleAssistant(m.content)
                          : m.content,
                      key: `r${transcriptKey.current}_${i}`
                    }));
                    setTranscript(items);
                    transcriptKey.current += 1;
                    messagesRef.current = [...r.value.messages];
                    setTokensUsed(estimateContextTokens(messagesRef.current));
                    setSessionTokensUsed(0);
                    setCostUsd(0);
                    sessionRef.current = r.value;
                    setSessionId(r.value.id);
                    setSessionTitle(r.value.title ?? null);
                    pushItem('system', `✦ resumed session ${target} (${items.length} turns)`);
                  } catch (e) {
                    pushItem('error', `resume failed: ${(e as Error).message}`);
                  }
                })();
                return;
              }
              if (action === 'rename') {
                const cur = sessionList.find((s) => s.id === target);
                setRenameDraft(cur?.title ?? '');
                setOverlay('sessions-rename');
                return;
              }
              if (action === 'delete') {
                setPendingDeleteSessionIds([target]);
                setOverlay('sessions-delete-confirm');
                return;
              }
            }}
            onCancel={() => setOverlay('sessions-list')}
          />
        ) : null}
        {overlay === 'sessions-delete-select' ? (
          <Picker
            title={`delete sessions · ${markedSessionIds.length}/${sessionList.length} selected`}
            descriptionColor={palette.warning}
            options={(() => {
              const marked = new Set(markedSessionIds);
              const opts: PickerOption[] = [
                {
                  value: '__delete_selected__',
                  label: `delete selected (${markedSessionIds.length})`,
                  description: markedSessionIds.length > 0 ? 'confirm before removing from disk' : 'mark at least one session first'
                },
                {
                  value: '__select_all__',
                  label: `select all ${sessionList.length}`,
                  description: 'mark every saved session'
                },
                {
                  value: '__clear__',
                  label: 'clear selection',
                  description: markedSessionIds.length > 0 ? 'unmark all sessions' : ''
                }
              ];
              for (const s of sessionList.slice(0, 50)) {
                const checked = marked.has(s.id);
                const when = typeof s.updatedAt === 'string'
                  ? s.updatedAt.slice(0, 19).replace('T', ' ')
                  : '';
                opts.push({
                  value: `toggle:${s.id}`,
                  label: `${checked ? '[x]' : '[ ]'} ${(s.title ?? s.id).padEnd(28)}`,
                  description: when
                });
              }
              opts.push({ value: '__back__', label: 'back to sessions', description: '' });
              return opts;
            })()}
            hint="↵ toggle/apply · Esc back"
            onChoose={(value) => {
              if (value === '__back__') {
                setOverlay('sessions-list');
                return;
              }
              if (value === '__select_all__') {
                setMarkedSessionIds(sessionList.map((s) => s.id));
                return;
              }
              if (value === '__clear__') {
                setMarkedSessionIds([]);
                return;
              }
              if (value === '__delete_selected__') {
                if (markedSessionIds.length === 0) {
                  pushItem('error', 'mark one or more sessions before deleting');
                  return;
                }
                setPendingDeleteSessionIds(markedSessionIds);
                setOverlay('sessions-delete-confirm');
                return;
              }
              if (value.startsWith('toggle:')) {
                const id = value.slice('toggle:'.length);
                setMarkedSessionIds((prev) =>
                  prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
                );
              }
            }}
            onCancel={() => setOverlay('sessions-list')}
          />
        ) : null}
        {overlay === 'sessions-delete-confirm' && pendingDeleteSessionIds.length > 0 ? (
          <Picker
            title={`delete ${pendingDeleteSessionIds.length} session${pendingDeleteSessionIds.length === 1 ? '' : 's'}?`}
            descriptionColor={palette.error}
            options={[
              {
                value: 'no',
                label: 'No — keep sessions',
                description: 'return to sessions'
              },
              {
                value: 'yes',
                label: 'Yes — delete from disk',
                description: 'cannot be undone'
              }
            ]}
            hint="↵ choose · Esc cancel"
            onChoose={(choice) => {
              if (choice !== 'yes') {
                setPendingDeleteSessionIds([]);
                setOverlay('sessions-list');
                return;
              }
              const store = props.sessionStore;
              const ids = [...pendingDeleteSessionIds];
              if (!store || ids.length === 0) {
                setPendingDeleteSessionIds([]);
                setOverlay('sessions-list');
                return;
              }
              setOverlay(null);
              setPendingDeleteSessionIds([]);
              void (async () => {
                let okCount = 0;
                let failCount = 0;
                for (const id of ids) {
                  const r = await store.remove(id);
                  if (r.ok) okCount += 1;
                  else failCount += 1;
                }
                if (sessionId && ids.includes(sessionId)) {
                  sessionRef.current = null;
                  setSessionId(null);
                  setSessionTitle(null);
                }
                setMarkedSessionIds([]);
                const refreshed = await store.list();
                if (refreshed.ok) {
                  setSessionList(refreshed.value);
                  if (refreshed.value.length > 0) setOverlay('sessions-list');
                }
                if (failCount === 0) {
                  pushItem('system', `✦ deleted ${okCount} session${okCount === 1 ? '' : 's'}`);
                } else {
                  pushItem('error', `deleted ${okCount}; ${failCount} failed`);
                }
              })();
            }}
            onCancel={() => {
              setPendingDeleteSessionIds([]);
              setOverlay('sessions-list');
            }}
          />
        ) : null}
        {overlay === 'sessions-rename' && selectedSession ? (
          <KeyEntry
            title={`✎  rename session · ${selectedSession.slice(0, 8)}`}
            help={
              `current: ${renameDraft || '(untitled)'}\n` +
              'Type a new title and press ↵. Empty input = no change.\n' +
              'The renamed session reflects on the header session chip.'
            }
            placeholder="new session title…"
            onSubmit={(v) => {
              const target = selectedSession;
              const store = props.sessionStore;
              if (!store || !target) {
                setOverlay(null);
                return;
              }
              const trimmed = v.trim();
              setOverlay(null);
              void (async () => {
                try {
                  const r = await store.rename(target, trimmed);
                  if (!r.ok) {
                    pushItem('error', `rename failed: ${r.error.message}`);
                    return;
                  }
                  setSessionList((prev) =>
                    prev.map((s) =>
                      s.id === target ? { ...s, title: r.value.title ?? '' } : s
                    )
                  );
                  // If the renamed session is the active one, reflect
                  // the new title in the header immediately.
                  if (sessionId === target) {
                    setSessionTitle(r.value.title ?? null);
                  }
                  pushItem(
                    'system',
                    `✎ renamed session ${target.slice(0, 8)} → "${r.value.title ?? ''}"`
                  );
                } catch (e) {
                  pushItem('error', `rename failed: ${(e as Error).message}`);
                }
              })();
            }}
            onCancel={() => setOverlay('sessions-actions')}
          />
        ) : null}
        {overlay === 'tools-list' ? (
          <Picker
            title={`tools (${toolStatusList.length})`}
            descriptionColor={palette.success}
            options={toolStatusList.map((t) => {
              const dot =
                t.status.state === 'connected'
                  ? '●'
                  : t.status.state === 'degraded'
                    ? '◐'
                    : t.status.state === 'disconnected'
                      ? '○'
                      : t.status.state === 'disabled'
                        ? '✗'
                        : '·';
              const badge = `${dot} ${t.status.state}`;
              return {
                value: t.entry.name,
                label: `${t.entry.name.padEnd(20)} ${t.entry.title ?? ''}`.trimEnd(),
                description: badge
              };
            })}
            hint="↵ pick · Esc close"
            onChoose={(name) => {
              setSelectedTool(name);
              setOverlay('tools-actions');
            }}
            onCancel={() => setOverlay(null)}
          />
        ) : null}
        {overlay === 'tools-actions' && selectedTool ? (
          <Picker
            title={`tool · ${selectedTool}`}
            options={(() => {
              const t = toolStatusList.find((x) => x.entry.name === selectedTool);
              if (!t) return [{ value: '__cancel', label: 'cancel', description: '' }];
              const opts: PickerOption[] = [];
              // Every tool gets enable/disable. We pick the opposite
              // of the current state so the picker reads as a toggle.
              const isDisabled = t.status.state === 'disabled';
              if (isDisabled) {
                opts.push({ value: 'enable', label: 'enable', description: 'turn this tool on' });
              } else {
                const warn = t.entry.essential
                  ? 'WARNING: essential tool — disabling may break workflows'
                  : 'turn this tool off';
                opts.push({ value: 'disable', label: 'disable', description: warn });
              }
              for (const a of t.entry.extraActions ?? []) {
                opts.push({
                  value: a.id,
                  label: a.id,
                  description: a.warning ?? a.label
                });
              }
              opts.push({ value: '__cancel', label: 'cancel', description: '' });
              return opts;
            })()}
            hint="↵ apply · Esc back"
            onChoose={(action) => {
              if (action === '__cancel') {
                setOverlay('tools-list');
                return;
              }
              const target = selectedTool;
              setOverlay(null);
              void (async () => {
                pushItem('system', `tool action: ${target} ${action}…`);
                try {
                  const result = await runToolAction(
                    target,
                    action as 'enable' | 'disable' | 'install' | 'start' | 'stop' | 'restart' | 'remove',
                    (line) => pushItem('system', `  ${line}`)
                  );
                  pushItem(
                    result.ok ? 'system' : 'error',
                    result.message
                  );
                  // Refresh catalog status so the next /tools open is fresh.
                  const registered = new Set(props.tools.list().map((x) => x.name));
                  const next = await resolveCatalogStatus(registered);
                  setToolStatusList(next);
                } catch (e) {
                  pushItem('error', `tool action failed: ${(e as Error).message}`);
                }
              })();
            }}
            onCancel={() => setOverlay('tools-list')}
          />
        ) : null}
        {overlay === 'onboard-loading' ? (
          <LoadingOverlay
            title="onboarding · scanning repo"
            body={onboardStatus || 'estimating cost…'}
            hint="Esc cancel"
          />
        ) : null}
        {overlay === 'onboard-existing-docs' && onboardDraft ? (() => {
          // Show the user every doc that the heuristic flagged as
          // potentially-onboarding-relevant. The default selection
          // is *all canonical docs* (the three Atlas would otherwise
          // generate) plus any heuristic match — the user can tick
          // off ones they don't want included. The footer line
          // surfaces the running token estimate so a "fresh start"
          // decision is informed.
          const fmtBytes = (n: number): string =>
            n >= 1024 ? `${Math.round(n / 1024)} kb` : `${n} b`;
          const fmtAge = (ms: number): string => {
            const d = Math.floor(ms / (24 * 60 * 60 * 1000));
            if (d > 0) return `${d}d old`;
            const h = Math.floor(ms / (60 * 60 * 1000));
            if (h > 0) return `${h}h old`;
            const mi = Math.floor(ms / (60 * 1000));
            return mi > 0 ? `${mi}m old` : 'just now';
          };
          const now = Date.now();
          const items = onboardDocCandidates.map((d) => ({
            value: d.relPath,
            label: `${d.kind === 'canonical' ? '★ ' : '  '}${d.relPath}`,
            description: `${fmtBytes(d.bytes)} · ${fmtAge(now - d.mtimeMs)}`
          }));
          // Pre-select every doc — the user opts OUT of ones they
          // think are stale, rather than opting in. Keeps the happy
          // path one-keystroke (Tab → Enter on Continue).
          const initial = new Set(onboardDocCandidates.map((d) => d.relPath));
          const pf = onboardDraft.preflight;
          const footer =
            `fresh onboard would write ~${pf.estimatedOutputTokensMin}-${pf.estimatedOutputTokensMax} output tokens` +
            ` (band: ${pf.costBand.toUpperCase()}, input ~${pf.estimatedInputTokens})`;
          const actions: MultiSelectAction[] = [
            {
              value: 'continue',
              label: 'Continue with selected',
              hint: 'agent will read these docs and update them in place — saves tokens'
            },
            {
              value: 'fresh',
              label: 'Start fresh',
              hint: 'ignore existing docs and regenerate from scratch'
            },
            { value: 'cancel', label: 'Cancel', hint: 'abort onboarding' }
          ];
          return (
            <MultiSelect
              title={`Found ${onboardDocCandidates.length} doc${onboardDocCandidates.length === 1 ? '' : 's'} that may already cover onboarding`}
              subtitle="Select which to reuse (★ = canonical onboarding doc):"
              items={items}
              initiallySelected={initial}
              actions={actions}
              footer={footer}
              onSubmit={(selected, action) => {
                if (action === 'cancel') {
                  setOverlay(null);
                  setOnboardDraft(null);
                  setOnboardDocCandidates([]);
                  return;
                }
                if (action === 'fresh') {
                  setOnboardDraft((d) =>
                    d ? { ...d, reuseDocs: [] } : d
                  );
                  setOverlay('onboard-mode');
                  return;
                }
                // continue
                const picked = onboardDocCandidates.filter((d) =>
                  selected.includes(d.relPath)
                );
                setOnboardDraft((d) => (d ? { ...d, reuseDocs: picked } : d));
                setOverlay('onboard-mode');
              }}
              onCancel={() => {
                setOverlay(null);
                setOnboardDraft(null);
                setOnboardDocCandidates([]);
              }}
            />
          );
        })() : null}
        {overlay === 'onboard-mode' && onboardDraft ? (
          <Picker
            title="onboarding mode"
            descriptionColor={palette.textMuted}
            options={[
              {
                value: 'full',
                label: 'full',
                description: 'repo map + brownfield-architecture.md + onboarding.md'
              },
              {
                value: 'cost-reduction',
                label: 'cost-reduction',
                description: 'split work between cheap + strong models'
              },
              {
                value: 'map-only',
                label: 'map-only',
                description: 'just write docs/repo-map.md and stop'
              }
            ]}
            hint="↵ pick · Esc cancel"
            onChoose={(value) => {
              const mode = value as OnboardMode;
              const draft: OnboardDraft = { ...onboardDraft, mode };
              if (mode === 'map-only') {
                setOnboardDraft(draft);
                setOverlay('onboard-confirm');
                return;
              }
              if (mode === 'full') {
                setOnboardDraft({ ...draft, strategy: 'same-model' });
                setOverlay('onboard-confirm');
                return;
              }
              setOnboardDraft(draft);
              setOverlay('onboard-strategy');
            }}
            onCancel={() => {
              setOverlay(null);
              setOnboardDraft(null);
            }}
          />
        ) : null}
        {overlay === 'onboard-strategy' && onboardDraft ? (
          <Picker
            title="cost-reduction strategy"
            descriptionColor={palette.textMuted}
            options={[
              { value: 'same-model', label: 'same-model', description: 'use one model for everything' },
              {
                value: 'cheap-fallback',
                label: 'cheap-fallback',
                description: 'cheap by default, escalate to fallback on hard sections'
              },
              {
                value: 'manual',
                label: 'manual',
                description: 'pick a model per stage (map / architecture / onboarding)'
              }
            ]}
            hint="↵ pick · Esc back"
            onChoose={(value) => {
              const strategy = value as OnboardStrategy;
              const draft: OnboardDraft = { ...onboardDraft, strategy };
              setOnboardDraft(draft);
              if (strategy === 'same-model') {
                setOnboardTarget('same');
              } else if (strategy === 'cheap-fallback') {
                setOnboardTarget('cheap');
              } else {
                setOnboardTarget('map');
              }
              setOverlay('onboard-pick-model');
            }}
            onCancel={() => setOverlay('onboard-mode')}
          />
        ) : null}
        {overlay === 'onboard-pick-model' && onboardDraft && onboardTarget ? (
          <Picker
            title={(() => {
              switch (onboardTarget) {
                case 'same':
                  return 'pick model (single)';
                case 'cheap':
                  return 'pick cheap model';
                case 'fallback':
                  return 'pick fallback model';
                case 'map':
                  return 'pick model for repo-map stage';
                case 'arch':
                  return 'pick model for architecture stage';
                case 'onboard':
                  return 'pick model for onboarding stage';
              }
            })()}
            options={modelOptions}
            initialValue={(() => {
              const d = onboardDraft;
              switch (onboardTarget) {
                case 'same':
                  return d.sameModel;
                case 'cheap':
                  return d.cheapModel;
                case 'fallback':
                  return d.fallbackModel;
                case 'map':
                  return d.stageModels?.map;
                case 'arch':
                  return d.stageModels?.architecture;
                case 'onboard':
                  return d.stageModels?.onboarding;
              }
            })()}
            hint="↵ pick · Esc back"
            onChoose={(chosen) => {
              const d = onboardDraft;
              if (onboardTarget === 'same') {
                setOnboardDraft({ ...d, sameModel: chosen });
                setOverlay('onboard-confirm');
                return;
              }
              if (onboardTarget === 'cheap') {
                setOnboardDraft({ ...d, cheapModel: chosen });
                setOnboardTarget('fallback');
                return;
              }
              if (onboardTarget === 'fallback') {
                setOnboardDraft({ ...d, fallbackModel: chosen });
                setOverlay('onboard-confirm');
                return;
              }
              if (onboardTarget === 'map') {
                setOnboardDraft({
                  ...d,
                  stageModels: {
                    ...(d.stageModels ?? {}),
                    map: chosen
                  }
                });
                setOnboardTarget('arch');
                return;
              }
              if (onboardTarget === 'arch') {
                setOnboardDraft({
                  ...d,
                  stageModels: {
                    ...(d.stageModels ?? {}),
                    architecture: chosen
                  }
                });
                setOnboardTarget('onboard');
                return;
              }
              if (onboardTarget === 'onboard') {
                setOnboardDraft({
                  ...d,
                  stageModels: {
                    ...(d.stageModels ?? {}),
                    onboarding: chosen
                  }
                });
                setOverlay('onboard-confirm');
                return;
              }
            }}
            onCancel={() => setOverlay('onboard-strategy')}
          />
        ) : null}
        {overlay === 'onboard-confirm' && onboardDraft ? (
          <Picker
            title={(() => {
              const p = onboardDraft.preflight;
              const cost = `${p.costBand.toUpperCase()} · in ~${p.estimatedInputTokens} tok · out ~${p.estimatedOutputTokensMin}-${p.estimatedOutputTokensMax}`;
              const plan =
                onboardDraft.strategy === 'same-model'
                  ? `single-model: ${onboardDraft.sameModel ?? activeModel}`
                  : onboardDraft.strategy === 'cheap-fallback'
                    ? `cheap+fallback: ${onboardDraft.cheapModel ?? activeModel} → ${onboardDraft.fallbackModel ?? activeModel}`
                    : `manual: map=${onboardDraft.stageModels?.map ?? activeModel}, arch=${onboardDraft.stageModels?.architecture ?? activeModel}, onb=${onboardDraft.stageModels?.onboarding ?? activeModel}`;
              return `confirm onboard · mode=${onboardDraft.mode} · ${cost} · ${plan}`;
            })()}
            options={[
              { value: 'start', label: 'start', description: 'write repo map + run onboarding' },
              { value: 'back', label: 'back', description: 'change something' },
              { value: 'cancel', label: 'cancel', description: '' }
            ]}
            hint="↵ apply · Esc cancel"
            onChoose={(value) => {
              if (value === 'cancel') {
                setOverlay(null);
                setOnboardDraft(null);
                return;
              }
              if (value === 'back') {
                setOverlay('onboard-mode');
                return;
              }
              // start → run onboard pipeline
              const draft = onboardDraft;
              setOnboardStatus('preparing onboard pipeline…');
              setOverlay('onboard-running');
              void (async () => {
                const cwd = props.toolContext.cwd;
                const fmtAge = (ms: number): string => {
                  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
                  if (days > 0) return `${days}d old`;
                  const hours = Math.floor(ms / (60 * 60 * 1000));
                  if (hours > 0) return `${hours}h old`;
                  const mins = Math.floor(ms / (60 * 1000));
                  return mins > 0 ? `${mins}m old` : 'just now';
                };
                const reuse = draft.reuseDocs ?? [];
                const reusedRepoMap = reuse.find(
                  (d) => d.relPath === 'docs/repo-map.md'
                );

                // Skip writeRepoMap when the user opted to reuse
                // docs/repo-map.md. Otherwise (or if they started
                // fresh) regenerate it from scratch.
                if (!reusedRepoMap) {
                  setOnboardStatus('writing repo map…');
                  const mapR = await writeRepoMap({ cwd });
                  if (!mapR.ok) {
                    pushItem('error', `onboard failed: ${mapR.error.message}`);
                    setOverlay(null);
                    setOnboardDraft(null);
                    return;
                  }
                  pushItem('system', `repo map written → ${mapR.value.path}`);
                } else {
                  pushItem(
                    'system',
                    `repo map already exists (${fmtAge(Date.now() - reusedRepoMap.mtimeMs)}) — reusing docs/repo-map.md`
                  );
                }

                if (draft.mode === 'map-only') {
                  pushItem('system', 'map-only complete. Use /next to continue orchestration.');
                  setOverlay(null);
                  setOnboardDraft(null);
                  return;
                }
                // Switch model if the plan picks a different one.
                const pickModel =
                  draft.strategy === 'same-model'
                    ? draft.sameModel
                    : draft.strategy === 'cheap-fallback'
                      ? draft.cheapModel
                      : draft.stageModels?.architecture;
                if (pickModel && pickModel !== activeModel) {
                  if (switchToModel(pickModel)) {
                    pushItem('system', `model → ${pickModel} (onboard plan)`);
                  }
                }
                const planLine =
                  draft.strategy === 'same-model'
                    ? `single-model: ${draft.sameModel ?? activeModel}`
                    : draft.strategy === 'cheap-fallback'
                      ? `cheap+fallback: ${draft.cheapModel ?? activeModel} -> ${draft.fallbackModel ?? activeModel}`
                      : `manual per-stage: map=${draft.stageModels?.map ?? activeModel}, architecture=${draft.stageModels?.architecture ?? activeModel}, onboarding=${draft.stageModels?.onboarding ?? activeModel}`;

                // Existing docs the user told us to read first.
                // We exclude docs/repo-map.md from this list — it's
                // already covered by the "Use as source-of-truth"
                // line below. The rest go in as canonical-shape +
                // heuristic-match docs the agent should not
                // regenerate.
                const reuseForPrompt = reuse.filter(
                  (d) => d.relPath !== 'docs/repo-map.md'
                );
                const now = Date.now();
                const existingDocs = reuseForPrompt.map(
                  (d) => `- ${d.relPath}  (${fmtAge(now - d.mtimeMs)})`
                );
                // Always (re)produce these unless the user picked
                // them as reuse targets — that's how Atlas tracks
                // brownfield onboarding state.
                const reusePaths = new Set(reuse.map((d) => d.relPath));
                const toProduce: string[] = [];
                if (!reusePaths.has('docs/brownfield-architecture.md')) {
                  toProduce.push('- docs/brownfield-architecture.md');
                }
                if (!reusePaths.has('docs/onboarding.md')) {
                  toProduce.push('- docs/onboarding.md');
                }

                const promptParts: string[] = [
                  '*onboard',
                  `Mode: ${draft.mode}`,
                  `Strategy: ${planLine}`,
                  `Estimated tokens: input~${draft.preflight.estimatedInputTokens}, output~${draft.preflight.estimatedOutputTokensMin}-${draft.preflight.estimatedOutputTokensMax}, band=${draft.preflight.costBand}`,
                  'Use docs/repo-map.md as source-of-truth.'
                ];
                if (existingDocs.length > 0) {
                  promptParts.push(
                    '',
                    'Existing docs (READ FIRST, then update IN PLACE — do NOT regenerate whole-cloth; only patch sections that are stale or missing relative to docs/repo-map.md):',
                    ...existingDocs
                  );
                }
                if (toProduce.length > 0) {
                  promptParts.push('', 'Produce (these do NOT exist yet):', ...toProduce);
                }
                promptParts.push(
                  '',
                  'Also seed .atlas/state.yaml artifacts when confidently inferable.',
                  'If confidence is low in any section, explicitly mark assumptions.'
                );
                const prompt = promptParts.join('\n');

                if (existingDocs.length > 0) {
                  pushItem(
                    'system',
                    `onboarding will read ${existingDocs.length} existing doc${existingDocs.length === 1 ? '' : 's'} (saves output tokens vs. regenerating)`
                  );
                }
                setOverlay(null);
                setOnboardDraft(null);
                // Inject prompt into composer and submit. Same
                // pattern as `/next` and the option-picker.
                setInput(prompt);
                const ta = composerRef.current as unknown as {
                  setText?: (s: string) => void;
                } | null;
                ta?.setText?.(prompt);
                void submit();
              })();
            }}
            onCancel={() => {
              setOverlay(null);
              setOnboardDraft(null);
            }}
          />
        ) : null}
        {overlay === 'onboard-running' ? (
          <LoadingOverlay
            title="onboarding · running"
            body={onboardStatus || 'working…'}
          />
        ) : null}
        {overlay === 'copy-picker' ? (() => {
          // Oldest first, newest at the bottom — initial selection
          // lands on the most recent message, which is what people
          // usually want to copy. Filter to user/assistant/thinking;
          // system + error rows are noise.
          const items = transcript.filter(
            (t) =>
              t.kind === 'assistant' ||
              t.kind === 'user' ||
              t.kind === 'thinking'
          );
          const last = items[items.length - 1];
          return (
          <Picker
            title="copy message · pick one"
            descriptionColor={palette.textMuted}
            options={items.map((t, i) => {
              const preview = t.text
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 70);
              const tag =
                t.kind === 'assistant'
                  ? 'assistant'
                  : t.kind === 'user'
                    ? 'you'
                    : 'thinking';
              return {
                value: t.key,
                label: `[${String(i + 1).padStart(3, ' ')}] ${tag.padEnd(9)} ${preview}`,
                description: `${t.text.length} chars`
              };
            })}
            {...(last ? { initialValue: last.key } : {})}
            hint="↵ copy via OSC 52 · Esc cancel"
            onChoose={(messageKey) => {
              const item = transcript.find((t) => t.key === messageKey);
              if (!item) {
                setOverlay(null);
                return;
              }
              const payload = Buffer.from(item.text, 'utf8').toString('base64');
              // OSC 52 ; c (clipboard buffer) ; <base64> BEL.
              process.stdout.write(`\x1b]52;c;${payload}\x07`);
              pushItem(
                'system',
                `✦ copied ${item.kind} message (${item.text.length} chars) to clipboard`
              );
              setOverlay(null);
            }}
            onCancel={() => setOverlay(null)}
          />
          );
        })() : null}
        {overlay === 'learn-confirm' && learnConfirm ? (() => {
          if (learnConfirm.stage === 'reflecting') {
            return (
              <LearnReflectingOverlay
                reason={learnConfirm.reason}
                revising={Boolean(learnConfirm.draft)}
              />
            );
          }
          if (learnConfirm.stage === 'saving') {
            return (
              <LoadingOverlay
                title="atlas is saving the learned skill"
                body="Writing skill to ~/.atlas/skills/…"
              />
            );
          }
          if (learnConfirm.stage === 'change' && learnConfirm.draft) {
            const draft = learnConfirm.draft;
            return (
              <KeyEntry
                title={`Change learned skill · ${draft.name}`}
                help={'Describe what to change. Atlas will revise the draft and show it again before saving.'}
                placeholder="e.g. add exact verification commands and shorten the trigger list"
                errorMessage={learnConfirm.error}
                onSubmit={(value) => {
                  setLearnConfirm({
                    stage: 'reflecting',
                    reason: learnConfirm.reason,
                    draft
                  });
                  void launchLearnRevision(draft, learnConfirm.reason, value);
                }}
                onCancel={() =>
                  setLearnConfirm({
                    stage: 'review',
                    reason: learnConfirm.reason,
                    draft
                  })
                }
              />
            );
          }
          // review
          if (!learnConfirm.draft) {
            return (
              <InfoOverlay
                title="✦ atlas wants to save a learned skill"
                body={`Reflection failed: ${learnConfirm.error ?? 'unknown error'}\n\nEsc to dismiss.`}
                tone="error"
                onClose={() => {
                  setLearnConfirm(null);
                  setOverlay(null);
                }}
              />
            );
          }
          const draft = learnConfirm.draft;
          return (
            <LearnDraftReviewOverlay
              draft={draft}
              reason={learnConfirm.reason}
              error={learnConfirm.error}
              onSave={() => void saveLearnedSkillDraft(draft, learnConfirm.reason)}
              onReject={() => {
                setLearnConfirm(null);
                setOverlay(null);
              }}
              onChange={() =>
                setLearnConfirm({
                  stage: 'change',
                  reason: learnConfirm.reason,
                  draft
                })
              }
            />
          );
        })() : null}
        {overlay === 'ship-conflict' && shipConflict ? (() => {
          const STRATS = [
            { key: 'abort' as const, desc: 'stop, print manual-resolution recipe' },
            {
              key: 'ours' as const,
              desc: `keep YOUR side — ${shipConflict.base} wins on every conflict`
            },
            {
              key: 'theirs' as const,
              desc: `keep THEIR side — ${shipConflict.branch} wins on every conflict`
            },
            {
              key: 'ai' as const,
              desc: 'let an AI agent read both sides + resolve markers (review!)'
            }
          ];
          const cols = width;
          const dialogWidth = Math.min(cols - 4, 90);
          const left = Math.max(2, Math.floor((cols - dialogWidth) / 2));
          return (
            <box
              style={{
                position: 'absolute',
                top: 2,
                left,
                width: dialogWidth,
                flexDirection: 'column',
                borderStyle: 'double',
                borderColor: palette.warning,
                backgroundColor: palette.backgroundElement,
                padding: 1
              }}
            >
              <text fg={palette.warning} attributes={BOLD_ATTR}>
                {`!!  Merge conflict — how should atlas resolve it?`}
              </text>
              <box style={{ marginTop: 1, flexDirection: 'column', backgroundColor: palette.backgroundElement }}>
                <text fg={palette.text}>
                  {`Merging ${shipConflict.branch} into ${shipConflict.base} hit ${shipConflict.conflictFiles.length} conflicting file${shipConflict.conflictFiles.length === 1 ? '' : 's'}:`}
                </text>
                {shipConflict.conflictFiles.slice(0, 8).map((f) => (
                  <text key={f} fg={palette.textMuted}>{`  · ${f}`}</text>
                ))}
                {shipConflict.conflictFiles.length > 8 ? (
                  <text fg={palette.textMuted}>
                    {`  · (+${shipConflict.conflictFiles.length - 8} more)`}
                  </text>
                ) : null}
              </box>
              <box style={{ marginTop: 1, flexDirection: 'column', backgroundColor: palette.backgroundElement }}>
                {STRATS.map((s, i) => {
                  const active = shipConflict.selected === s.key;
                  return (
                    <text key={s.key} fg={active ? palette.primaryBright : palette.text}>
                      {`  ${active ? '>' : ' '} [${i + 1}] ${s.key.padEnd(7)} ${s.desc}`}
                    </text>
                  );
                })}
                <box style={{ marginTop: 1, backgroundColor: palette.backgroundElement }}>
                  <text fg={palette.textDim}>
                    {`tip: "ours" = the branch you're ON (${shipConflict.base}). "theirs" = the one being merged IN (${shipConflict.branch}). git's wording, not ours.`}
                  </text>
                </box>
              </box>
              <box style={{ marginTop: 1, backgroundColor: palette.backgroundElement }}>
                <text fg={palette.text}>
                  {`  ${shipConflict.persist ? '[x]' : '[ ]'} [p / space] save this choice as my default for the future`}
                </text>
              </box>
              <box style={{ marginTop: 1, backgroundColor: palette.backgroundElement }}>
                <text fg={palette.textDim}>
                  {`up/down select · 1-4 jump · enter confirm · esc abort`}
                </text>
              </box>
            </box>
          );
        })() : null}
        {overlay === 'skills-list' ? (
          <Picker
            title={`skills (${props.skills.list().length})`}
            descriptionColor={palette.success}
            options={props.skills.list().map((s) => {
              const kindBadge =
                s.kind === 'builtin'
                  ? '[builtin]'
                  : s.kind === 'learned'
                    ? '[learned]'
                    : '[user]';
              return {
                value: s.name,
                label: `● ${s.name.padEnd(22)} ${s.description ?? ''}`.trimEnd(),
                description: kindBadge
              };
            })}
            hint="↵ pick · Esc close · /skills enable <name> to re-enable"
            onChoose={(name) => {
              setSelectedSkill(name);
              setOverlay('skills-actions');
            }}
            onCancel={() => setOverlay(null)}
          />
        ) : null}
        {overlay === 'skills-actions' && selectedSkill ? (
          <Picker
            title={`skill · ${selectedSkill}`}
            options={(() => {
              const s = props.skills.list().find((x) => x.name === selectedSkill);
              const opts: PickerOption[] = [
                {
                  value: 'view',
                  label: 'view description',
                  description: s?.description ?? ''
                },
                {
                  value: 'disable',
                  label: 'disable',
                  description: 'mute this skill for next session'
                },
                { value: '__cancel', label: 'cancel', description: '' }
              ];
              return opts;
            })()}
            hint="↵ apply · Esc back"
            onChoose={(action) => {
              const target = props.skills.list().find((x) => x.name === selectedSkill);
              if (!target) {
                setOverlay('skills-list');
                return;
              }
              if (action === '__cancel') {
                setOverlay('skills-list');
                return;
              }
              if (action === 'view') {
                const triggers =
                  target.triggers.length > 0
                    ? `\n  triggers: ${target.triggers.join(', ')}`
                    : '';
                pushItem(
                  'system',
                  `skill · ${target.name} [${target.kind}] v${target.version}\n  ${target.description}${triggers}\n  path: ${target.path}`
                );
                setOverlay(null);
                return;
              }
              if (action === 'disable') {
                setOverlay(null);
                void setSkillDisabled(target.path, true).then((r) => {
                  if (!r.ok) {
                    pushItem(
                      'error',
                      `failed to disable ${target.name}: ${r.error.message}`
                    );
                    return;
                  }
                  pushItem(
                    'system',
                    `disabled ${target.name} (${r.value}). Restart atlas to drop it from the active session.`
                  );
                });
                return;
              }
            }}
            onCancel={() => setOverlay('skills-list')}
          />
        ) : null}
      </box>

      {/* Statusbar */}
      <box
        style={{
          width: '100%',
          height: 1,
          flexDirection: 'row',
          backgroundColor: palette.backgroundPanel,
          paddingLeft: 1,
          paddingRight: 1
        }}
      >
        <box style={{ flexGrow: 1, flexDirection: 'row', backgroundColor: palette.backgroundPanel }}>
          <text fg={error ? palette.error : palette.textMuted}>
            {error
              ? `error: ${error}`
              : `${input.length > 0 ? `${input.length} chars · ` : ''}${STATUSBAR}`}
          </text>
        </box>
        <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundPanel }}>
          <text fg={palette.textDim}>pwd: </text>
          <text fg={palette.secondary}>{props.toolContext.cwd}</text>
        </box>
      </box>
    </box>
  );
};
