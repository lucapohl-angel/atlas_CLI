/** @jsxImportSource @opentui/react */
/**
 * Splash — startup hero shown when the transcript is empty.
 *
 * Mirrors the Ink TUI's `Splash` component (App.tsx ~line 7128):
 * centered ATLAS OS block-letter wordmark in an Atlas-blue gradient
 * (bright top → primary mid → secondary footing), tagline, model
 * line, terminal-size hint, and the leader-key cheat-sheet.
 */
import { palette } from './palette.js';

const LINES = [
  '  █████╗ ████████╗██╗      █████╗ ███████╗    ██████╗ ███████╗',
  ' ██╔══██╗╚══██╔══╝██║     ██╔══██╗██╔════╝   ██╔═══██╗██╔════╝',
  ' ███████║   ██║   ██║     ███████║███████╗   ██║   ██║███████╗',
  ' ██╔══██║   ██║   ██║     ██╔══██║╚════██║   ██║   ██║╚════██║',
  ' ██║  ██║   ██║   ███████╗██║  ██║███████║   ╚██████╔╝███████║',
  ' ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝    ╚═════╝ ╚══════╝'
] as const;

const GRADIENT = [
  palette.primaryBright,
  palette.primaryBright,
  palette.primary,
  palette.primary,
  palette.secondary,
  palette.secondary
] as const;

export const Splash = ({ defaultModel }: { defaultModel: string }) => {
  return (
    <box
      style={{
        flexDirection: 'column',
        alignItems: 'center',
        marginTop: 1,
        marginBottom: 1,
        backgroundColor: palette.backgroundPanel
      }}
    >
      <box style={{ flexDirection: 'column', backgroundColor: palette.backgroundPanel }}>
        {LINES.map((l, i) => (
          <text key={i} fg={GRADIENT[i] ?? palette.primary}>
            {l}
          </text>
        ))}
      </box>

      <box style={{ marginTop: 1, backgroundColor: palette.backgroundPanel }}>
        <text fg={palette.text}>
          Autonomous Teams · Lifecycle · Agents · Skills — Orchestration System
        </text>
      </box>

      <box
        style={{
          flexDirection: 'row',
          backgroundColor: palette.backgroundPanel
        }}
      >
        <text fg={palette.textMuted}>spec-driven development crew · </text>
        <text fg={palette.text}>{defaultModel}</text>
      </box>

      <box style={{ marginTop: 1, backgroundColor: palette.backgroundPanel }}>
        <text fg={palette.warning}>
          for the best experience, run Atlas in a fullscreen or reasonably-sized terminal window.
        </text>
      </box>

      <box
        style={{
          marginTop: 1,
          flexDirection: 'row',
          backgroundColor: palette.backgroundPanel
        }}
      >
        <text fg={palette.primary}>/</text>
        <text fg={palette.textMuted}> commands · </text>
        <text fg={palette.primary}>Tab</text>
        <text fg={palette.textMuted}> agent · </text>
        <text fg={palette.primary}>Ctrl-O</text>
        <text fg={palette.textMuted}> model · </text>
        <text fg={palette.primary}>Ctrl-T</text>
        <text fg={palette.textMuted}> thinking · </text>
        <text fg={palette.primary}>Ctrl-D</text>
        <text fg={palette.textMuted}>×2 exit</text>
      </box>
    </box>
  );
};
