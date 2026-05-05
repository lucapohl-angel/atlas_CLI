/** @jsxImportSource @opentui/react */
/**
 * Sidebar — right-hand activity panel.
 *
 * Mirrors the Ink TUI sidebar: token usage chip on top, recent
 * activity list below. The activity list is wired to the OpenTUI
 * variant's tool-call telemetry — `OpenTuiApp` pushes the last N
 * tool names + a streaming flag into `recentTools`.
 */
import { palette } from './palette.js';
import { styleForTool } from './tool-style.js';

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
  readonly tokensUsed: number;
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
  const liveThinking =
    props.thinkingLine && props.thinkingLine.trim().length > 0
      ? props.thinkingLine.trim().slice(-120)
      : null;

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
        <text fg={barColor}>
          {formatTokens(props.tokensUsed)}/{formatBudget(props.contextWindow)}
        </text>
      </box>
      {/* Each metric row gets its own accent so the eye can scan
          the column at a glance: ratio (muted), tool-count (info
          cyan), spend (warning amber), phase (purple accent). */}
      <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundPanel }}>
        <text fg={palette.textDim}>{`${Math.round(ratio * 100)}%  `}</text>
        <text fg={palette.info}>
          {`${props.toolCount ?? 0} tool${(props.toolCount ?? 0) === 1 ? '' : 's'}`}
        </text>
      </box>
      {props.costUsd !== undefined && props.costUsd > 0 ? (
        <box style={{ flexDirection: 'row', backgroundColor: palette.backgroundPanel }}>
          <text fg={palette.textDim}>{'spend  '}</text>
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

      {/* Live "thinking" line — surfaces what the model is reasoning
          about right now (when the provider emits thinking deltas).
          Magenta to match the Ink TUI's `◇` thinking marker. */}
      {liveThinking ? (
        <box
          style={{
            marginTop: 1,
            flexDirection: 'row',
            backgroundColor: palette.backgroundPanel
          }}
        >
          <text fg={palette.accent}>◇ </text>
          <text fg={palette.accent}>{liveThinking}</text>
        </box>
      ) : null}

      {recent.length > 0 ? (
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
