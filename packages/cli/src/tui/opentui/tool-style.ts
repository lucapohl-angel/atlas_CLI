/**
 * Per-tool icons and colors for the OpenTUI variant.
 *
 * Atlas is "no-emoji by policy" — both in the model's responses and
 * in the renderer's chrome. Every tool gets a short ASCII glyph (1-2
 * chars wide) and a stable accent color so the user can scan the
 * sidebar / transcript and recognise tool calls at a glance the same
 * way VS Code's terminal panel uses per-extension colored dots.
 *
 * The lookup is name-prefix based so MCP-prefixed variants
 * (`mcp__github__*`, `mcp__memory__*`, …) inherit the right family
 * without an explicit entry per sub-tool.
 */
import { palette } from './palette.js';

export interface ToolStyle {
  /** 1-2 char ASCII glyph. Never an emoji. */
  readonly icon: string;
  /** Foreground color for the icon AND the tool name. */
  readonly color: string;
}

const STYLES: ReadonlyArray<readonly [RegExp, ToolStyle]> = [
  // Filesystem reads
  [/^(read_file|read|cat|ls|list_dir|file_search|glob)$/i,
    { icon: '[r]', color: palette.secondary }],
  // Filesystem writes
  [/^(write_file|write|create_file|create_directory)$/i,
    { icon: '[w]', color: palette.success }],
  // Filesystem edits
  [/^(edit_file|edit|patch|apply_patch|multi_replace_string_in_file|replace_string_in_file)$/i,
    { icon: '[e]', color: palette.warning }],
  // Search / grep
  [/^(grep_search|grep|search|semantic_search|ripgrep|rg)$/i,
    { icon: '[?]', color: palette.info }],
  // Shell / terminal
  [/^(terminal|shell|bash|run|exec|run_in_terminal|run_command|spawn)$/i,
    { icon: '[$]', color: palette.primaryBright }],
  // Web
  [/^(web_search|search_web|websearch)$/i,
    { icon: '[w]', color: palette.accent }],
  [/^(web_fetch|fetch|http|fetch_webpage)$/i,
    { icon: '[h]', color: palette.accent }],
  // Browser
  [/^(browser|playwright|navigate|click|screenshot|page)/i,
    { icon: '[b]', color: palette.primary }],
  // Todo / task
  [/^(todo|task|update_task|start_task|clear_active_task)/i,
    { icon: '[t]', color: palette.warning }],
  // Ship / git
  [/^(ship|git|commit|push|merge|rebase)/i,
    { icon: '[s]', color: palette.success }],
  // GitHub MCP
  [/^mcp__github/i,
    { icon: '[g]', color: '#9d7cd8' }],
  // Filesystem MCP
  [/^mcp__filesystem/i,
    { icon: '[f]', color: palette.secondary }],
  // Memory / knowledge graph MCP
  [/^mcp__memory/i,
    { icon: '[m]', color: palette.accent }],
  // Figma MCP
  [/^mcp__figma/i,
    { icon: '[F]', color: '#f5a742' }],
  // Higgsfield MCP
  [/^mcp__higgsfield/i,
    { icon: '[H]', color: '#56b6c2' }],
  // Generic MCP
  [/^mcp__/i,
    { icon: '[M]', color: palette.primary }],
  // Atlas-internal: think / plan / discover / phase advances
  [/^(think|plan|discover|advance|phase)/i,
    { icon: '[*]', color: palette.accent }],
  // Skills / load_skill
  [/^(skill|load_skill|skills?)$/i,
    { icon: '[k]', color: palette.info }]
];

/**
 * Resolve the style for a tool name. Falls back to a neutral
 * dot-icon styled in the muted text color when no rule matches —
 * the user still sees the call, just without a brand color.
 */
export const styleForTool = (name: string): ToolStyle => {
  for (const [re, style] of STYLES) {
    if (re.test(name)) return style;
  }
  return { icon: '[\u00b7]', color: palette.textMuted };
};
