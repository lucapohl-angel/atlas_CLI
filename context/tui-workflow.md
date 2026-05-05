# Atlas TUI — User Workflow Specification

> **Source of truth** for the user experience of the Atlas TUI in
> both Ink (`packages/cli/src/tui/App.tsx`) and OpenTUI
> (`packages/cli/src/tui/opentui/OpenTuiApp.tsx`) variants.
>
> When adding or changing any UI surface in either variant, **first
> read this file** and mirror the rule in the other variant in the
> same commit. Inconsistencies become user-visible bugs and are
> tracked as parity gaps in `context/progress-tracker.md`.

## Contract

**State machine, gating rules, slash commands, and data sources MUST
be identical across the two variants.** Visuals (colors, borders,
popup widths) MAY differ within the same Atlas-blue navy palette
(see `packages/cli/src/tui/opentui/palette.ts` and the App.tsx
inline `palette` near line 69).

## Top-level layout

| Region        | Height  | Content                                                 |
|---------------|---------|---------------------------------------------------------|
| Header        | 1 row   | agent role · model [TAG] · mode · responsive chips      |
| Transcript    | flex    | wrapped text bubbles per role + markdown + code blocks  |
| Sidebar       | 46 cols | activity log + cost + context-window bar (cols ≥ 100)   |
| Slash popup   | ≤ 8 rows| command suggestions when input starts with `/` no space |
| Composer      | ≥ 3 rows| multiline textarea with inline cursor                   |
| Status bar    | 1 row   | keybinding hints + autopilot warning when active        |

## Color invariants (palette → element)

- **Connected status badges**: `palette.success` (green) `●` glyph.
- **Disconnected / not configured**: `palette.textMuted` plain text.
- **Section headers** in pickers: `palette.accent` (purple) bold,
  format `── Provider ──`. Headers are not selectable — the cursor
  skips them on ↑/↓ and Enter is a no-op.
- **★ Popular** sub-header (OpenRouter only): `palette.accent`,
  inset by three spaces.
- **Pinned popular item** unselected: `palette.warning` (yellow)
  with `★ ` prefix.
- **Selected row** (any picker): `palette.success` (green) bold with
  `❯ ` prefix and inverted background.
- **Provider tags** in header: OR=accent, AN=warning, CDX=success.
- **Mode** chip in header / status: plan=warning, build=success,
  autopilot=error bold.
- **Phase** colors: idle=textMuted, discover=info, plan=accent,
  execute=warning, verify=primary, ship=success.

## Overlays (popup convention)

- **Width**: `min(72, terminalCols - 4)` chars. Never full-width.
- **Position**: horizontally centered (`left = floor((cols - width) / 2)`),
  vertical anchor `top: 1` for pickers, `top: 2` for setup / info.
- **Border**: `palette.primary` single for normal pickers,
  `palette.warning` double for autopilot warning, `palette.error`
  double for destructive confirmations.
- **Background**: always `palette.backgroundElement` (raised tile).
- **Hint line** at the bottom: `↑/↓ navigate · ↵ choose · Esc cancel`
  (or surface-specific variant).
- **Esc** always closes the topmost overlay and resets any transient
  error state.

## Slash command system

When the user types `/` at the start of the input (no space yet), an
**autocomplete popup** appears **directly above** the composer:

- Border: `palette.primary` round, background `backgroundPanel`.
- Width: same centered width as overlays.
- ≤ 8 visible rows. If more matches: footer shows `↑↓ select · Tab
  complete · ↵ run  ·  N/M`.
- Filter: case-insensitive `startsWith` on the part after `/`.
- Highlighted row: `palette.primaryBright` bold, `❯ ` prefix.
- Inactive rows: `palette.primary` (name) + `palette.textMuted`
  (description).
- ↑/↓: cycle (wraps).
- Tab: replace input with `/<full-name> ` (cursor after the space).
- Enter (with matches): execute the highlighted command, ignoring
  whatever the user actually typed.
- Esc: close the popup, leave input as-is.

### Canonical command list (must stay in sync)

| Command   | Args                                 | Summary |
|-----------|--------------------------------------|---------|
| help      | —                                    | show this list |
| clear     | —                                    | clear the conversation |
| history   | —                                    | print the message history |
| model     | `<id>`                               | switch model (no arg → open picker) |
| models    | —                                    | open the model picker |
| restart   | `models`                             | force-refresh the live model catalog |
| agent     | `<name> [model]`                     | switch agent (or bind a model) |
| agents    | —                                    | list installed agents |
| mode      | `plan\|build\|autopilot`             | set permission mode |
| thinking  | `off\|low\|medium\|high\|xhigh`      | set reasoning effort (model-aware) |
| config    | —                                    | open the config menu |
| mcps      | `[add\|enable…\|disable…\|remove…]`  | list / add / toggle MCP servers |
| sessions  | `[id]`                               | list / resume saved sessions |
| resume    | `[id]`                               | resume a session (alias of /sessions) |
| compact   | `[now\|status\|on\|off\|model\|threshold]` | auto-compaction controls |
| learn     | `[on\|off\|status]`                  | self-improvement loop |
| skills    | `[list\|disable…\|enable…]`          | manage installed skills |
| next      | —                                    | ask Atlas which command to run next |
| onboard   | —                                    | brownfield onboarding wizard |
| tools     | —                                    | browse / enable / disable built-in tools |
| status    | —                                    | show current workflow phase |
| back      | `<phase>`                            | rewind to an earlier phase |
| skip      | —                                    | jump forward |
| abort     | —                                    | abandon the current task |
| exit      | —                                    | leave atlas |
| quit      | —                                    | leave atlas (alias) |

Stub unimplemented commands with a clear "not yet ported" message.
Never fail silently.

## `/config` menu (post-setup runtime)

7 entries in fixed order, each with a connected/configured badge in
the description column:

1. `OpenRouter API key  (sk-or-…)` — green ● connected when
   `props.providers.openrouter` is live, else "not configured".
2. `Anthropic API key   (sk-ant-…)` — connected when
   `config.providers.anthropic.apiKey` is set.
3. `Claude Code OAuth   (auto-detected)` — connected when
   anthropic provider runtime exists *without* an explicit key.
4. `Sign in with ChatGPT (browser, Codex)` — connected when
   `props.providers['openai-codex']` is live. PKCE flow is
   browser-based; OpenTUI variant routes to `--ui=ink` until ported.
5. `GitHub token        (gh integration)` — connected when
   `config.github.token` is set.
6. `MCP server          (model context protocol)` — count badge,
   `● N configured`. Selecting opens the MCP submenu (catalog).
7. `Ship: auto-merge    (current: <strategy>, prompt: on/off)` —
   currently info-only in OpenTUI; full editor in Ink.

### Key entry stage

- Title: `⚙  <Provider> API key`.
- Help text references the `~/.atlas/config.yaml` save location and
  links to the dashboard URL.
- Note about comma-separated keys = primary + fallback rotation
  on 401/429.
- Masked input: characters render in the same color as the
  background; the buffer is preserved internally.
- Enter saves via `saveConfig` and pushes a system message
  confirming the path. Esc cancels.

### MCP submenu

When selecting "MCP server" from `/config`, a sub-picker shows the
**curated catalog** plus any custom-added entries:

| ID         | Pricing  | Transport | Notes |
|------------|----------|-----------|-------|
| filesystem | free     | stdio     | npx `@modelcontextprotocol/server-filesystem` |
| github     | byo      | stdio     | `github-mcp-server` binary; OAuth or PAT |
| higgsfield | paid     | http      | hosted image/video gen MCP |
| figma      | freemium | http      | hosted Figma MCP |
| memory     | builtin  | stdio     | shipped by default; cannot be removed via UI |

Each row shows: name, pricing tag, transport, and whether already
configured. Selecting a not-yet-configured server walks the user
through any required env vars. Selecting an already-configured one
offers enable/disable/remove.

For the OpenTUI variant: env collection is currently **info-only**
(it tells the user what to add to `~/.atlas/config.yaml`). The full
interactive add wizard lives in Ink and is tracked as a parity gap.

## Model picker

Grouped by provider, fixed order:

1. `── Anthropic ──`
2. `── OpenAI (ChatGPT / Codex) ──`
3. `── OpenRouter ──`
   - `   ★ Popular` (sub-header) followed by ≤ 10 curated entries
     matched against the live catalog by regex
   - Rest of OpenRouter catalog ∪ seed defaults ∪
     `config.providers.openrouter.customModels`, alphabetised
   - `+ Add custom model id…` row at the bottom (Ink only;
     OpenTUI gap)

A section is omitted if its provider has neither runtime nor
catalog entries. If everything is empty, fall back to a flat seed
list so the user can still pick something.

The "★ Popular" list is **hardcoded** in both variants for
offline reliability. It is matched against the live catalog by
regex; if a pattern doesn't match a real id, the fallback id is
shown anyway.

## Agent picker

- Tab opens the picker **only when** `switchableAgents.length > 1`
  where `switchableAgents = allAgents.filter(a => !isFrameworkAgent(a))`.
  The orchestrator (`atlas`) is always included.
- Framework specialists (Athena, Prometheus, Hercules, …) are
  routed-to by `atlas` and never picked manually.
- Each row: `role  ·  name`. Tag `[framework]` / `[user]` colored
  accent / success.

## Thinking picker

- `THINKING_CYCLE = ['off', 'low', 'medium', 'high', 'xhigh']`.
- Filter per active model via `thinkingLevelsFor(activeModel,
  modelCatalog)`. Reject unsupported levels in `/thinking <level>`
  with the allowed set.
- Ctrl-T cycles within the filtered set.
- Header chip shows current level when not `off` (in `palette.accent`).

## Mode picker

- `plan` → `build` → `autopilot` → `plan`.
- Switching to autopilot opens a confirmation modal once per
  session. Autopilot adds a red bold `⚠ AUTOPILOT` badge to the
  status bar.

## Composer

- Multiline textarea, Enter sends, Ctrl-J / Alt-Enter / Shift-Enter
  inserts a newline.
- ↑/↓ scroll input history (only when input is empty).
- Esc cancels streaming.
- Ctrl-D twice within 1 s exits.
- Placeholder: `Message Atlas (↵ send · Ctrl-J newline · / for commands)`.

## Status bar

```
Tab agent · Ctrl-O model · Ctrl-T think · Ctrl-P mode · ↵ send · Ctrl-J newline · Ctrl-D ×2 exit
```

When streaming: replace `↵ send` with `Esc/Ctrl-C cancel`.
When mode is autopilot: append red bold `  ⚠ AUTOPILOT`.

## Keyboard shortcuts (global)

| Key           | Action                                                    |
|---------------|-----------------------------------------------------------|
| Tab           | open agent picker (if switchableAgents.length > 1)         |
| Ctrl-O        | open model picker                                          |
| Ctrl-T        | cycle thinking level                                       |
| Ctrl-P        | cycle mode                                                 |
| Esc           | cancel streaming / close overlay / close slash popup       |
| Ctrl-C        | cancel streaming                                           |
| Ctrl-D ×2     | exit (within 1 s)                                          |
| Ctrl-Y        | copy last code block (Ink only — OpenTUI gap)              |
| PgUp/PgDn     | scroll transcript                                          |
| Enter         | send (or run highlighted slash command)                    |
| Ctrl-J        | insert newline                                             |
| ↑/↓ in popup  | cycle highlight                                            |
| Tab in popup  | autocomplete the slash command name                        |

## Parity rule

When you change any of the rules above in one variant, you MUST
either:

1. mirror the change in the other variant in the same commit, or
2. note the gap in `context/progress-tracker.md` under "OpenTUI
   parity gaps" with a one-line entry pointing back to the rule.

Silent divergence is not acceptable.

## Round 6 invariants (composer, popups, sidebar, OAuth)

These rules were tightened after a screenshot review of the OpenTUI
variant. Both variants must satisfy them.

### Composer

- **Multi-line input.** The composer is a `textarea`, not a single-
  line input. Enter sends; **Shift-Enter** *and* Ctrl-J insert a
  newline. Same shortcuts VS Code's chat input uses.
- **Auto-grow.** The composer box height grows with the number of
  lines, capped (OpenTUI: 8 rows, Ink: until 1/3 of the terminal).
  As it grows it pushes the chat scrollback up so the user keeps
  seeing what they wrote.
- **Streaming border = bright yellow.** While the model is streaming
  (between `submit()` and the final `done` event), the composer's
  border switches to `palette.warning` so the active state is
  unmistakable. Border returns to `palette.primary` (focused) /
  `palette.border` (unfocused) when streaming ends.

### Slash autocomplete

- **Anchored to the composer.** The popup opens directly above the
  composer at the same width — full chat-column width minus the
  sidebar. It is **not** a centered overlay. Visually it looks like
  the composer "grew upward" to show suggestions, matching VS Code
  Copilot Chat's slash menu.
- **Wrap-around.** ↑ at index 0 jumps to the last suggestion; ↓ at
  the last jumps to 0.
- **Auto-scroll the visible window.** When the highlighted command is
  outside the rendered window, scroll so it's visible. Never let the
  cursor escape off-screen.
- **No `/models` alias.** Only `/model` exists; the alias was
  removed because it duplicated the picker entry.

### Pickers (model, agent, mode, thinking)

- **Wrap-around scrolling.** All pickers must wrap at both ends so
  the user can press ↓ continuously and reach every entry. Holding
  ↓ past the last item lands back on the first.
- **Sticky section headers.** When the cursor is on the first item
  of a section, the section header (and any contiguous header rows
  above it) **must remain visible**. Scroll-to-cursor logic walks
  backwards through preceding headers and includes them in the
  visible window.
- **Vertically centered.** Picker overlays compute `top` so the box
  is centered vertically as well as horizontally. Pass `rows` and
  `height` to `centeredOverlayStyle` (or the Ink equivalent) so the
  popup never hugs the top of the terminal.

### Right-hand activity sidebar

- **Width 38–46 cols.** Wide enough to show a tool name + status +
  the live thinking line without truncating after 6 chars.
- **Live thinking line.** When the provider emits `thinking` deltas,
  the sidebar shows the latest tail of the model's reasoning,
  prefixed with a magenta `◇`. Cleared on the next `submit()`.
- **Streaming chip.** While streaming, the sidebar header shows
  `● streaming` in `palette.warning` (yellow). Idle state shows
  `idle` in `palette.textDim`. The sidebar's outer border also
  switches to yellow while streaming.
- **Recent tool history.** Shows the last 8 tool invocations, newest
  first, with status icon + name (✓ done, ✗ error, ◌ running).

### Anthropic OAuth health

- **Detect expiry on mount.** The TUI calls
  `loadClaudeCodeCredentials({})` and stores
  `anthropicOAuthExpired = expiresAt && expiresAt < Date.now()`.
- **Hide expired Anthropic models.** When `anthropicOAuthExpired`
  *and* there's no `config.providers.anthropic.apiKey`, the model
  picker replaces the Anthropic section with two header rows:
  - `── Anthropic (OAuth expired) ──`
  - `   ⚠ run \`claude\` in another terminal to refresh, then /restart models`
- This prevents users from picking a model that will 401 on the
  first turn.

### Assistant rendering safety net

- **Use `assistantMessage.content` as truth.** On `turn_end`, the
  TUI must rebuild the visible assistant text from
  `ev.assistantMessage.content` (the model's final committed
  message). Some providers don't emit deltas for short responses;
  others batch the whole reply after `tool_call_done`. Without this
  net the user sees `atlas:` with no body.
- **Turn boundary flag.** After flushing, set a `turnBoundary` flag
  so the *next* delta starts a NEW transcript entry (not replaces
  the just-committed one). Multi-round responses (text → tool →
  more text) must show every round.
