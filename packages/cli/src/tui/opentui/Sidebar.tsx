/** @jsxImportSource @opentui/react */
/**
 * Sidebar — right-hand activity panel.
 *
 * Mirrors the Ink TUI sidebar: token usage chip on top, recent
 * activity list below. The activity list is wired to the OpenTUI
 * variant's tool-call telemetry — `OpenTuiApp` pushes the last N
 * tool names + a streaming flag into `recentTools`.
 *
 * When the agent has produced a todo list (via the `todo` tool), we
 * surface that *instead of* the recent-tools list — a live checklist
 * is more useful than a tail of tool names while the agent is
 * grinding through a multi-step task.
 */
import { palette } from './palette.js';
import { styleForTool } from './tool-style.js';

/**
 * Single row of the sidebar todo strip. Status comes straight from
 * `TodoStore` — the renderer maps it to a glyph + color.
 */
export interface SidebarTodo {
  readonly id: string;
  readonly content: string;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
};

const formatBudget = (n: number): string => {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}m`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
};

const formatElapsed = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
};

const formatUsd = (usd: number): string => {
  if (usd <= 0) return '';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
};

export interface SidebarToolEvent {
  readonly key: string;
  readonly name: string;
  readonly status: 'running' | 'done' | 'error';
  /** Wall-clock elapsed time in ms once the tool finished. */
  readonly elapsedMs?: number;
}

export interface SidebarProps {
  /** Approximate tokens in the live model-facing context after compaction. */
  readonly tokensUsed: number;
  /** Cumulative provider tokens spent this session. */
  readonly sessionTokensUsed?: number;
  readonly contextWindow: number;
  readonly streaming: boolean;
  readonly toolCount?: number;
  readonly recentTools?: readonly SidebarToolEvent[];
  /**
   * The model's currently-streaming chain-of-thought line, if any.
   * Populated when the provider emits `thinking` events. We surface
   * the live tail (truncated) so the user sees that the model is
   * actively reasoning even when it's not emitting answer tokens.
   */
  readonly thinkingLine?: string | null;
  /** Cumulative session spend in USD. Hidden when zero / unknown. */
  readonly costUsd?: number;
  /** Workflow phase line, when an active task exists. */
  readonly phaseLine?: string | null;
  /**
   * Live todo list owned by the agent. When non-empty, takes over
   * the sidebar's "activity" slot in place of the recent-tools tail
   * — a concrete checklist beats a stream of tool names when the
   * agent has decomposed the task. Hidden entirely when empty.
   */
  readonly todos?: readonly SidebarTodo[];
}

export const Sidebar = (props: SidebarProps) => {
  const ratio =
    props.contextWindow > 0 ? props.tokensUsed / props.contextWindow : 0;
  const barColor =
    ratio > 0.85
      ? palette.error
      : ratio > 0.6
        ? palette.warning
        : palette.success;

  // Cap the visible list. The Ink TUI shows the last ~8 entries; same
  // here so the sidebar never overflows on short terminals.
  const recent = (props.recentTools ?? []).slice(-8).reverse();

  return (
    <box
      style={{
        width: 38,
        // The right activity panel is part of the row-flex layout
        // alongside the chat column. Without an explicit minHeight
        // and flexShrink:0, a tall transcript can squeeze the
        // sidebar down to 1–2 rows on short terminals — then the
        // user loses sight of token usage entirely. Pin a 3-row
        // floor so at minimum the token chip + ratio + activity
        // header stay visible.
        flexShrink: 0,
        minHeight: 3,
        flexDirection: 'column',
        backgroundColor: palette.backgroundPanel,
        borderColor: props.streaming ? palette.warning : palette.borderSubtle,
        borderStyle: 'single',
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0
      }}
    >
      <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundPanel }}>
        <text fg={palette.textDim}>ctx   </text>
        <text fg={barColor}>
          {formatTokens(props.tokensUsed)}/{formatBudget(props.contextWindow)}
        </text>
      </box>
      <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundPanel }}>
        <text fg={palette.textDim}>used  </text>
        <text fg={palette.secondary}>{formatTokens(props.sessionTokensUsed ?? 0)}</text>
        <text fg={palette.textDim}>{`  ${Math.round(ratio * 100)}%`}</text>
      </box>
      {/* Each metric row gets its own accent so the eye can scan
          the column at a glance: tool-count (info cyan), cost
          (warning amber), phase (purple accent). */}
      <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundPanel }}>
        <text fg={palette.textDim}>{'tools '}</text>
        <text fg={palette.info}>
          {String(props.toolCount ?? 0)}
        </text>
      </box>
      {props.costUsd !== undefined && props.costUsd > 0 ? (
        <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundPanel }}>
          <text fg={palette.textDim}>{'cost  '}</text>
          <text fg={palette.warning}>{formatUsd(props.costUsd)}</text>
        </box>
      ) : null}
      {props.phaseLine ? (
        <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundPanel }}>
          <text fg={palette.accent}>{props.phaseLine}</text>
        </box>
      ) : null}

      <box
        style={{
          marginTop: 1,
          flexDirection: 'row',
          backgroundColor: palette.backgroundPanel
        }}
      >
        <text fg={palette.accent}>activity</text>
        <text fg={palette.backgroundPanel}>{' '}</text>
        {props.streaming ? (
          <text fg={palette.warning}>● streaming</text>
        ) : (
          <text fg={palette.textDim}>idle</text>
        )}
      </box>

      {/* The live "thinking" tail used to render here (◇ purple
          line). Removed — the timeline card above the chat already
          shows the streaming reasoning step in place, and surfacing
          it twice was visual noise that competed with the todo
          list for attention in a 38-col sidebar. */}

      {/* Live todo list (replaces recent-tools when the agent has
          produced one). Status glyphs:
            [x] completed → green
            [>] in_progress → warning amber, bold-ish
            [ ] pending → muted
            [~] cancelled → strikethrough-ish dim
          Cap visible rows so a long list doesn't push tools / spend
          off-screen on shorter terminals. */}
      {props.todos && props.todos.length > 0 ? (
        <box
          style={{
            marginTop: 1,
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
            <text fg={palette.accent}>todos</text>
            <text fg={palette.textDim}>
              {`  ${props.todos.filter((t) => t.status === 'completed').length}/${props.todos.length}`}
            </text>
          </box>
          {props.todos.slice(0, 10).map((t) => {
            const glyph =
              t.status === 'completed'
                ? '[x]'
                : t.status === 'in_progress'
                  ? '[>]'
                  : t.status === 'cancelled'
                    ? '[~]'
                    : '[ ]';
            const glyphColor =
              t.status === 'completed'
                ? palette.success
                : t.status === 'in_progress'
                  ? palette.warning
                  : t.status === 'cancelled'
                    ? palette.textDim
                    : palette.textMuted;
            const textColor =
              t.status === 'completed'
                ? palette.textDim
                : t.status === 'cancelled'
                  ? palette.textDim
                  : palette.text;
            // Word-aware wrap for long descriptions. The 38-col
            // sidebar minus 2 col padding minus 4 col glyph leaves
            // ~32 cols per line for content; continuation rows get
            // a 4-space indent so they visually align under the
            // first character of the description rather than the
            // glyph. Without this the content was being truncated
            // mid-word and users couldn't read the rest of the task.
            const WRAP_WIDTH = 32;
            const words = t.content.split(/\s+/);
            const lines: string[] = [];
            let line = '';
            for (const w of words) {
              if (w.length === 0) continue;
              const trial = line.length === 0 ? w : `${line} ${w}`;
              if (trial.length <= WRAP_WIDTH) {
                line = trial;
              } else {
                if (line.length > 0) lines.push(line);
                // Hard-break a single word that's longer than the
                // wrap width so we never produce a row that bleeds
                // off the right edge of the sidebar.
                if (w.length > WRAP_WIDTH) {
                  for (let i = 0; i < w.length; i += WRAP_WIDTH) {
                    lines.push(w.slice(i, i + WRAP_WIDTH));
                  }
                  line = '';
                } else {
                  line = w;
                }
              }
            }
            if (line.length > 0) lines.push(line);
            if (lines.length === 0) lines.push(t.content); // fallback for whitespace-only content
            return (
              <box
                key={`todo-${t.id}`}
                style={{
                  flexDirection: 'column',
                  backgroundColor: palette.backgroundPanel
                }}
              >
                {lines.map((ln, idx) => (
                  <box
                    key={`todo-${t.id}-l${idx}`}
                    style={{
                      flexDirection: 'row',
                      backgroundColor: palette.backgroundPanel
                    }}
                  >
                    {idx === 0 ? (
                      <text fg={glyphColor}>{`${glyph} `}</text>
                    ) : (
                      <text fg={palette.backgroundPanel}>{'    '}</text>
                    )}
                    <text fg={textColor}>{ln}</text>
                  </box>
                ))}
              </box>
            );
          })}
          {props.todos.length > 10 ? (
            <text fg={palette.textDim}>{`… +${props.todos.length - 10} more`}</text>
          ) : null}
        </box>
      ) : recent.length > 0 ? (
        <box
          style={{
            marginTop: 1,
            flexDirection: 'column',
            backgroundColor: palette.backgroundPanel
          }}
        >
          {recent.map((t) => {
            const style = styleForTool(t.name);
            // Status glyph stays generic so "running / done / error"
            // reads consistently across tools; the per-tool ASCII
            // icon and color come from `styleForTool` so users can
            // scan the column and recognise file/edit/web/etc. at a
            // glance the way VS Code's terminal panel uses colored
            // dots per extension.
            const statusGlyph =
              t.status === 'running' ? '..' : t.status === 'error' ? 'xx' : 'ok';
            const statusColor =
              t.status === 'error'
                ? palette.error
                : t.status === 'running'
                  ? palette.warning
                  : palette.success;
            return (
              <box
                key={t.key}
                style={{
                  flexDirection: 'row',
                  backgroundColor: palette.backgroundPanel
                }}
              >
                <text fg={statusColor}>{statusGlyph} </text>
                <text fg={style.color}>{style.icon} </text>
                <text fg={style.color}>{t.name}</text>
                {t.elapsedMs !== undefined ? (
                  <text fg={palette.textDim}>{` · ${formatElapsed(t.elapsedMs)}`}</text>
                ) : null}
              </box>
            );
          })}
        </box>
      ) : null}
    </box>
  );
};
