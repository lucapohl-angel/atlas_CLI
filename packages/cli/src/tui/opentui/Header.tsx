/** @jsxImportSource @opentui/react */
/**
 * Header — top chip bar.
 *
 * Mirrors the Ink TUI's `Header` component (App.tsx ~line 5971): role
 * (colored by agent), model + provider tag, mode, thinking effort.
 * Phase 2 of the OpenTUI port: phase / session / git / streaming
 * chips are intentionally omitted — they require state we don't yet
 * surface in the OpenTUI variant. Width-responsive collapsing is also
 * deferred.
 */
import { createTextAttributes } from '@opentui/core';
import { palette } from './palette.js';

const BOLD = createTextAttributes({ bold: true });

export type Mode = 'plan' | 'build' | 'autopilot';
export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

const colorForAgent = (name: string): string => {
  // Stable hash → pick from a small Atlas-blue-friendly palette.
  // Same algorithm as the Ink TUI so the same agent gets the same color.
  const palettePool = [
    palette.primary,
    palette.primaryBright,
    palette.accent,
    palette.secondary,
    palette.success,
    palette.warning
  ];
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) | 0;
  return palettePool[Math.abs(h) % palettePool.length] ?? palette.primary;
};

const modeColor = (m: Mode): string =>
  m === 'autopilot'
    ? palette.warning
    : m === 'plan'
      ? palette.secondary
      : palette.primary;

export interface HeaderProps {
  readonly agentName: string;
  readonly agentRole: string;
  readonly model: string;
  readonly providerTag: string;
  readonly mode: Mode;
  readonly thinking: ThinkingEffort;
  readonly streaming: boolean;
  /** Active session title (shown after the thinking chip). */
  readonly sessionTitle?: string | null;
}

export const Header = (props: HeaderProps) => {
  return (
    <box
      style={{
        width: '100%',
        height: 3,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: palette.backgroundElement,
        borderColor: palette.primary,
        borderStyle: 'single',
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <text fg={colorForAgent(props.agentName)} attributes={BOLD}>{props.agentRole}</text>
      <text fg={palette.textMuted}> · </text>
      <text fg={palette.text}>{props.model}</text>
      <text fg={palette.accent}> [{props.providerTag}]</text>
      <text fg={palette.textMuted}> · </text>
      <text fg={modeColor(props.mode)} attributes={BOLD}>{props.mode}</text>
      <text fg={palette.textMuted}> · think </text>
      <text fg={props.thinking === 'off' ? palette.textMuted : palette.accent}>
        {props.thinking}
      </text>
      {props.sessionTitle ? (
        <>
          <text fg={palette.textMuted}> · session </text>
          <text fg={palette.secondary} attributes={BOLD}>{props.sessionTitle}</text>
        </>
      ) : null}
      {props.streaming ? (
        <>
          <text fg={palette.textMuted}> · </text>
          <text fg={palette.warning} attributes={BOLD}>streaming</text>
        </>
      ) : null}
    </box>
  );
};
