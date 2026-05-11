# VS Code Extension — Build Plan (Header → Picker → Workflow)

> Generated 2026-05-09 from the complete Atlas Core → VS Code UI mapping.
> Skips: activity sidebar, popup overlay system, story visualization,
> workflow chain viz (deferred to later phases per user direction).

## Design System (already established — do not change)

| Token | Value | Usage |
|---|---|---|
| `--atlas-bg` | `#0a0d14` | Main canvas |
| `--atlas-bg-elev` | `#0f1320` | Cards, raised surfaces |
| `--atlas-bg-panel` | `#11162a` | Panels, dropdowns |
| `--atlas-line` | `#1d2435` | Borders, dividers |
| `--atlas-fg` | `#e6edf3` | Primary text |
| `--atlas-dim` | `#8b96a8` | Secondary text |
| `--atlas-faint` | `#5b6477` | Muted text |
| `--atlas-accent` | `#4fb8ff` | Atlas bright blue — buttons, active states, borders |
| `--atlas-accent-soft` | `#4fb8ff2a` | Hover backgrounds |
| `--atlas-accent-glow` | `#4fb8ff99` | Focus rings, glow effects |
| `--atlas-success` | `#aff5b4` | Connected badges, success states |
| `--atlas-warning` | `#ffaa00` | Popular items, warnings |
| `--atlas-error` | `vscodeErrorForeground` | Errors, destructive actions |
| Font: brand | Orbitron 800 | `ΛTLΛS·OS` wordmark only |
| Font: body | Geist 400/500/600 | All UI text |
| Font: mono | JetBrains Mono 400/500 | Code, file paths, metadata |

**Power badge colors** (from OpenTUI palette, port to CSS):
- Atlas Power Full: `#ff315f` (neon red)
- Atlas Smart: `#39ff88` (neon green)

**Provider tag colors** (from OpenTUI palette, port to CSS):
- OpenRouter (OR): `#9d7cd8` (accent/purple)
- Anthropic (AN): `#f5a742` (warning/orange)
- Codex (CDX): `#7fd88f` (success/green)

**Phase colors** (from OpenTUI palette, port to CSS):
- idle: `#6b7896` (textDim)
- discover: `#56b6c2` (info)
- plan: `#9d7cd8` (accent)
- execute: `#f5a742` (warning)
- verify: `#5c9cf5` (primary)
- ship: `#7fd88f` (success)

---

## Phase 1 — Header Chips & Status Bar

**Goal**: Make the top bar feel like Atlas. Power badge, mode chip, provider
tag, thinking level, and a bottom status bar with keybinding hints.

### 1.1 Atlas Power Badge

- Source: `config.atlasMode` from `getSettings` response (already in bridge).
- Render: `<span>` chip in header next to brand lockup.
  - `atlasMode === 'full'` → `ATLAS POWER` in `#ff315f` (neon red), bold.
  - `atlasMode === 'smart'` → `ATLAS SMART` in `#39ff88` (neon green), bold.
- CSS: `.powerBadge` with `font-family: var(--atlas-brand-font)`, small caps,
  letter-spacing.
- Update: re-renders when settings refresh after `/config` save.

### 1.2 Mode Chip

- Source: new bridge request `getMode` → returns `'plan' | 'build' | 'autopilot'`.
  Or fold into `getStatus` response.
- Render: `<span>` chip in header.
  - `plan` → `--atlas-warning` background tint, "PLAN" text.
  - `build` → `--atlas-success` background tint, "BUILD" text.
  - `autopilot` → `--atlas-error` background tint, bold "AUTOPILOT" text.
- CSS: `.modeChip` with rounded pill, 10px font, uppercase.
- Interaction: clicking cycles plan → build → autopilot → plan.
  Autopilot shows a confirmation inline before committing.

### 1.3 Provider Tag

- Source: `status.providerName` from `getStatus` (already in bridge).
- Render: small tag next to model name in header.
  - `openrouter` → `OR` in `#9d7cd8`.
  - `anthropic` → `AN` in `#f5a742`.
  - `openai-codex` → `CDX` in `#7fd88f`.
  - `local` → `LOCAL` in `--atlas-dim`.
  - `opencode-zen` → `ZEN` in `#9d7cd8`.
  - `opencode-go` → `GO` in `#56b6c2`.
- CSS: `.providerTag` with mono font, 9px, uppercase, 1px border.

### 1.4 Thinking Level Chip

- Source: new field in `getStatus` or `getModels` response —
  `activeThinking: ThinkingLevel`.
- Render: chip showing current level when not `off`.
  - `off` → hidden.
  - `low` / `medium` / `high` / `xhigh` → shown in `--atlas-accent`.
- CSS: `.thinkingChip` with mono font, 9px.
- Interaction: clicking opens a small dropdown with available levels
  (filtered per active model via `thinkingLevelsFor`).

### 1.5 Status Bar

- Source: static keybinding hints + autopilot warning from mode state.
- Render: fixed `<footer>` at bottom of webview, above composer.
  - Left: `Tab agent · Ctrl+O model · Ctrl+T thinking · Esc cancel`
  - Right: autopilot warning `⚠ AUTOPILOT` in red bold when mode is autopilot.
- CSS: `.statusBar` with `--atlas-bg-panel` background, 22px height,
  `--atlas-dim` text, 11px font.

### Files touched

- `packages/vscode/src/ui/main.tsx` — header layout, new chips, status bar.
- `packages/vscode/src/ui/styles.css` — `.powerBadge`, `.modeChip`,
  `.providerTag`, `.thinkingChip`, `.statusBar`.
- `packages/vscode/src/bridge.ts` — add `getMode` / `setMode` /
  `setThinking` if not folded into existing requests.
- `packages/vscode/src/extension.ts` — handle new bridge requests.

### Acceptance criteria

- Header shows: [ΛTLΛS·OS] [ATLAS POWER] [PLAN] [OR] [model-name] [high].
- Power badge color matches atlasMode.
- Mode chip cycles on click with autopilot confirmation.
- Provider tag color matches provider.
- Thinking chip shows/hides correctly.
- Status bar shows keybinding hints.
- Autopilot warning appears in status bar when active.

---

## Phase 2 — Model Picker (Grouped + Search)

**Goal**: Replace the flat `QuickSelect` with a grouped, searchable model
picker that matches the TUI contract.

### 2.1 Provider-Grouped List

- Source: `getModels` response (already in bridge — `ModelSummary[]` with
  `provider` and `providerLabel` fields).
- Render: a slide-out panel or dropdown with sections:
  1. `── Local (Ollama / LM Studio) ──` (if any local models)
  2. `── Anthropic ──`
  3. `── OpenAI (ChatGPT / Codex) ──`
  4. `── OpenCode Go ──`
  5. `── OpenCode Zen ──`
  6. `── OpenRouter ──`
     - `   ★ Popular` sub-header (yellow, inset)
     - Popular models with `★ ` prefix in `--atlas-warning`
     - Rest alphabetically
- Each row: `model.id` · `promptCacheLabel` · `contextWindow` ctx.
- Active model: `❯ ` prefix in `--atlas-success` bold.
- Configured default: subtle `(default)` tag.
- Section headers: `--atlas-accent` (purple), bold, not selectable.
- CSS: `.modelPicker`, `.modelGroup`, `.modelGroupHeader`, `.modelRow`,
  `.modelRowActive`, `.popularHeader`, `.popularRow`.

### 2.2 Search/Filter

- Source: client-side filter on `ModelSummary[]`.
- Render: `<input>` at top of picker with search icon.
- Behavior: typing filters by `id` or `label`, case-insensitive `includes`.
  ↑/↓ navigates filtered results. Enter selects. Esc closes.

### 2.3 Prompt Cache Labels

- Source: `promptCacheLabel` from `ModelSummary` (already in bridge).
- Render: `cache: yes (cheaper)` in `--atlas-success`, `cache: unknown` in
  `--atlas-dim`, `cache: no` in `--atlas-faint`.
- Derive from live catalog pricing fields, not provider-name heuristics.

### 2.4 Model Selection

- Source: `selectModel` bridge request (already exists).
- Behavior: selecting a model sends `selectModel` with `id` + `provider`.
  On success, refresh status + models. Show action notice.

### Files touched

- `packages/vscode/src/ui/main.tsx` — new `ModelPicker` component, replace
  flat QuickSelect for models.
- `packages/vscode/src/ui/styles.css` — all picker styles.
- `packages/vscode/src/bridge.ts` — may need `promptCache` enum on
  `ModelSummary` (check if already present).

### Acceptance criteria

- Model picker shows provider-grouped sections in fixed order.
- ★ Popular section appears for OpenRouter with yellow stars.
- Active model has green `❯ ` prefix.
- Search filters in real time.
- ↑/↓/Enter/Esc keyboard navigation works.
- Selecting a model updates the session.
- Cache labels are accurate per model.

---

## Phase 3 — Agent Picker Polish

**Goal**: Add `[framework]` / `[user]` tags and proper empty-state handling
to the existing agent picker.

### 3.1 Agent Kind Tags

- Source: `AgentSummary.kind` from `getAgents` (already in bridge).
- Render: tag after agent name.
  - `framework` → `[framework]` in `--atlas-accent` (purple).
  - `user` → `[user]` in `--atlas-success` (green).
- CSS: `.agentKindTag` with mono font, 9px.

### 3.2 Empty / Single-Agent State

- Source: `AgentSummaryResult.switchableCount` (already in bridge).
- Behavior:
  - `switchableCount <= 1` → Tab does nothing, shows notice:
    "Install custom agents under `~/.atlas/agents/` to enable manual switching."
  - `switchableCount > 1` → Tab opens picker.
- Already partially implemented — verify and polish.

### 3.3 Agent Description in Picker

- Source: `AgentSummary.role` + `AgentSummary.description` (already in bridge).
- Render: two-line rows — name + kind tag on line 1, `role · description`
  on line 2 in `--atlas-dim`.

### Files touched

- `packages/vscode/src/ui/main.tsx` — agent picker rows.
- `packages/vscode/src/ui/styles.css` — `.agentKindTag`, `.agentRow`.

### Acceptance criteria

- Framework agents show `[framework]` tag in purple.
- User agents show `[user]` tag in green.
- Single-agent state shows clear notice, no broken picker.
- Agent rows show role + description.

---

## Phase 4 — Thinking & Mode Pickers

**Goal**: Add dedicated pickers for thinking level and permission mode.

### 4.1 Thinking Picker

- Source: new bridge request `getThinkingLevels` → returns
  `{ active: ThinkingLevel, available: ThinkingLevel[] }`.
  Or add `activeThinking` + `availableThinking` to `getModels` response.
- Render: small dropdown from the thinking chip in header.
  - Cycle: `off → low → medium → high → xhigh → off`.
  - Only show levels in `available` set.
  - Unsupported levels rejected with allowed-set message.
- Keyboard: Ctrl+T cycles within available set.
- Bridge: `setThinking` request with `{ level: ThinkingLevel }`.

### 4.2 Mode Picker

- Source: new bridge request `getMode` → returns
  `{ mode: 'plan' | 'build' | 'autopilot' }`.
- Render: clicking mode chip in header cycles:
  `plan → build → autopilot → plan`.
- Autopilot confirmation: when switching TO autopilot, show an inline
  confirm dialog: "Autopilot executes tools without asking. Continue?"
  with Yes/No buttons.
- Bridge: `setMode` request with `{ mode: 'plan' | 'build' | 'autopilot' }`.

### Files touched

- `packages/vscode/src/ui/main.tsx` — thinking dropdown, mode cycle,
  autopilot confirm.
- `packages/vscode/src/ui/styles.css` — `.thinkingDropdown`, `.confirmDialog`.
- `packages/vscode/src/bridge.ts` — `getThinkingLevels`, `setThinking`,
  `getMode`, `setMode` schemas.
- `packages/vscode/src/extension.ts` — handle new requests.
- `packages/vscode/src/session-host.ts` — expose thinking/mode state.

### Acceptance criteria

- Thinking chip shows current level, hidden when off.
- Ctrl+T cycles through available levels.
- Unsupported levels are rejected with clear message.
- Mode chip cycles plan → build → autopilot.
- Autopilot triggers confirmation dialog.
- Both pickers update header chips immediately.

---

## Phase 5 — Settings /config Alignment

**Goal**: Make the settings screen match the 11-entry `/config` menu from
the TUI contract, with connected badges and submenus.

### 5.1 11-Entry Config Menu

- Source: `getSettings` response (already in bridge).
- Render: fixed-order list matching TUI contract:
  1. OpenRouter API key — green ● if `providers.openrouter.configured`.
  2. Anthropic API key — green ● if `providers.anthropic.configured`.
  3. OpenCode Go key — green ● if `providers.opencodeGo.configured`.
  4. OpenCode Zen key — green ● if `providers.opencodeZen.configured`.
  5. Claude Code OAuth — green ● if `providers.anthropic.oauthEnabled`.
  6. Sign in with ChatGPT — green ● if `providers.openaiCodex.configured`.
  7. Atlas power mode — always configured, shows current mode.
  8. Local models — green ● if local provider detected.
  9. GitHub token — green ● if `github.configured`.
  10. MCP server — `● N configured` badge.
  11. Ship: auto-merge — info-only, shows current strategy.
- Each row: name, status badge, action button or submenu indicator.
- CSS: `.configMenu`, `.configRow`, `.configBadge`.

### 5.2 Atlas Power Submenu

- Source: `settings.atlasMode` (already in bridge).
- Render: panel with two mode cards:
  - **Atlas Power Full**: 100k-250k input tokens, cache-capable, max context.
  - **Atlas Smart**: 20k-80k input tokens, cost-aware, cache-friendly.
  - Active mode marked `[ACTIVE]`.
  - Save button writes `atlasMode` via `updateSettings`.
- CSS: `.powerSubmenu`, `.powerCard`, `.powerCardActive`.

### 5.3 Local Mode Submenu

- Source: `settings.providers.local` (already in bridge).
- Render: panel with three mode cards:
  - **Lite**: CPU ok, 4-8 GB RAM, 1.5B-7B models, chat only.
  - **Hybrid**: 8-12 GB VRAM, 7B-14B models, compact prompt + core tools.
  - **Full**: 24 GB+ VRAM, 30B-70B+ models, full Atlas surface.
  - Active mode marked `[ACTIVE]`.
  - Save writes `providers.local.toolMode` via `updateSettings`.
- CSS: `.localSubmenu`, `.localCard`, `.localCardActive`.

### 5.4 Connected Badges

- Source: provider `configured` fields (already in bridge).
- Render: green `●` + "connected" when configured, `--atlas-dim` "not
  configured" otherwise.
- CSS: `.connectedBadge` with `--atlas-success` color.

### Files touched

- `packages/vscode/src/ui/main.tsx` — `SettingsScreen` restructure,
  `PowerSubmenu`, `LocalSubmenu`.
- `packages/vscode/src/ui/styles.css` — all config menu styles.

### Acceptance criteria

- Settings shows 11 entries in TUI contract order.
- Connected providers show green ● badge.
- Power submenu shows Full vs Smart with cost estimates.
- Local submenu shows Lite/Hybrid/Full with requirements.
- Saving updates config and refreshes settings.

---

## Phase 6 — MCP Catalog & Management

**Goal**: Show the curated MCP catalog with pricing tags, transport info,
and docs links.

### 6.1 Curated Catalog View

- Source: `getMcpStatus` response (already in bridge — `McpServerSummary`
  has `source`, `transport`, `docs`, `summary`).
- Render: catalog section at top of MCP screen showing:
  | filesystem | free | stdio | npx `@modelcontextprotocol/server-filesystem` |
  | github | byo | stdio | `github-mcp-server` binary; OAuth or PAT |
  | higgsfield | paid | http | hosted image/video gen MCP |
  | figma | freemium | http | hosted Figma MCP |
  | memory | builtin | stdio | shipped by default; cannot be removed |
- Each row: name, pricing tag (free/byo/paid/freemium/builtin), transport,
  configured status, action button.
- Pricing tag colors: free=success, byo=dim, paid=warning, freemium=info,
  builtin=accent.
- CSS: `.mcpCatalog`, `.mcpCatalogRow`, `.pricingTag`.

### 6.2 Configured Servers Section

- Source: `getMcpStatus.servers` filtered by `source === 'configured'`.
- Render: below catalog, list of user-configured servers with
  enable/disable toggle, remove button, status indicator.
- Status colors: running=success, disabled=dim, failed=error,
  not-configured=faint.

### 6.3 Add Server Flow

- Source: `addMcpServer` + `upsertMcpServer` (already in bridge).
- Render: "Add MCP Server" button → inline form with name, transport
  select, command/args or URL fields, enabled toggle.
- CSS: `.addMcpForm`.

### Files touched

- `packages/vscode/src/ui/main.tsx` — `McpScreen` restructure.
- `packages/vscode/src/ui/styles.css` — catalog, pricing tags, form.

### Acceptance criteria

- Catalog shows 5 curated servers with pricing tags.
- Pricing tags are color-coded.
- Configured servers show enable/disable/remove.
- Add form creates new server entries.
- Memory server shows as builtin, non-removable.

---

## Phase 7 — Task & Workflow Surface

**Goal**: Make the task screen show phase colors, workflow state, and
actionable phase transitions.

### 7.1 Phase Colors

- Source: `TaskSummary.phase` from `getTaskStatus` (already in bridge).
- Render: phase badge with color:
  - `idle` → `#6b7896` (textDim)
  - `discover` → `#56b6c2` (info)
  - `plan` → `#9d7cd8` (accent)
  - `execute` → `#f5a742` (warning)
  - `verify` → `#5c9cf5` (primary)
  - `ship` → `#7fd88f` (success)
- CSS: `.phaseBadge` with dynamic color per phase.

### 7.2 Task Details

- Source: `TaskSummary` fields (already in bridge).
- Render: task title, phase badge, note, updated time, context doc path
  (clickable), plan doc path (clickable).
- CSS: `.taskCard`, `.taskMeta`.

### 7.3 Todo List

- Source: `getTodos` response (already in bridge).
- Render: checklist with status icons:
  - `pending` → `○` in `--atlas-dim`.
  - `in_progress` → `◉` in `--atlas-warning`.
  - `completed` → `✓` in `--atlas-success`.
  - `cancelled` → `✗` in `--atlas-faint`.
- CSS: `.todoList`, `.todoItem`, `.todoStatus`.

### 7.4 Workflow Commands (actionable)

- Source: local slash command routing (already exists).
- Render: button row for `/back`, `/skip`, `/abort`, `/next` with
  current phase context.
- Behavior:
  - `/back <phase>` — needs bridge request `setPhase`.
  - `/skip` — needs bridge request `skipPhase`.
  - `/abort` — needs bridge request `abortTask`.
  - `/next` — asks Atlas for recommendation (uses existing `runTurn`).
- Bridge: new requests `setPhase`, `skipPhase`, `abortTask`.

### Files touched

- `packages/vscode/src/ui/main.tsx` — `TaskScreen` restructure.
- `packages/vscode/src/ui/styles.css` — phase badges, todo list.
- `packages/vscode/src/bridge.ts` — `setPhase`, `skipPhase`, `abortTask`.
- `packages/vscode/src/extension.ts` — handle new requests.

### Acceptance criteria

- Phase badge color matches TUI contract.
- Task card shows title, phase, note, time, doc paths.
- Todo list shows status icons with correct colors.
- Workflow command buttons are wired and functional.

---

## Phase 8 — Token Usage & Cost Display

**Goal**: Show per-turn token counts and cost estimates.

### 8.1 Usage in Chat Bubbles

- Source: `TokenUsage` from `done` stream event (already in bridge).
- Render: collapsible footer in assistant bubble:
  - `↑ 12.3k ↓ 1.2k · cache read 8.1k · $0.04`
  - Prompt tokens (↑), completion tokens (↓), cache read, cache creation.
- CSS: `.usageFooter` with `--atlas-faint` text, 10px mono font.

### 8.2 Context Window Bar

- Source: `ModelSummary.contextWindow` + running token count.
- Render: thin progress bar showing context fill percentage.
  - Green < 50%, yellow 50-80%, red > 80%.
- CSS: `.contextBar`, `.contextFill`.

### Files touched

- `packages/vscode/src/ui/main.tsx` — `ChatBubble` usage footer.
- `packages/vscode/src/ui/styles.css` — `.usageFooter`, `.contextBar`.

### Acceptance criteria

- Each assistant bubble shows token usage when available.
- Cache read/creation tokens are displayed separately.
- Context window bar shows fill percentage with color thresholds.

---

## Phase 9 — Skills, Tools & Compaction Management

**Goal**: Add management screens for skills, tools, compaction, and learn
controls.

### 9.1 Skills Management

- Source: new bridge request `getSkills` → returns skill list with
  enabled/disabled state.
- Render: list of skills with name, description, enable/disable toggle.
- Bridge: `getSkills`, `setSkillEnabled`.
- CSS: `.skillList`, `.skillRow`.

### 9.2 Tools Browser

- Source: `settings.tools` (already in bridge — `SettingsToolSummary[]`).
- Render: list of tools with name, description, approval policy badge
  (auto/ask/never).
- Bridge: `setToolApproval` for changing approval policy.
- CSS: `.toolList`, `.toolRow`, `.approvalBadge`.

### 9.3 Compaction Controls

- Source: `settings.compaction` (already in bridge).
- Render: panel with:
  - Enable/disable toggle.
  - Model selector for compaction model.
  - Threshold slider (0.0–1.0).
  - Context token limit input.
  - Current status indicator.
- Bridge: already covered by `updateSettings`.
- CSS: `.compactionPanel`.

### 9.4 Learn Controls

- Source: new bridge request `getLearnStatus` → returns
  `{ enabled: boolean }`.
- Render: toggle for self-improvement loop.
- Bridge: `getLearnStatus`, `setLearn`.
- CSS: `.learnToggle`.

### Files touched

- `packages/vscode/src/ui/main.tsx` — new management panels.
- `packages/vscode/src/ui/styles.css` — all panel styles.
- `packages/vscode/src/bridge.ts` — `getSkills`, `setSkillEnabled`,
  `setToolApproval`, `getLearnStatus`, `setLearn`.
- `packages/vscode/src/extension.ts` — handle new requests.

### Acceptance criteria

- Skills list shows enable/disable per skill.
- Tools list shows approval policy per tool.
- Compaction panel has all controls wired.
- Learn toggle works.

---

## Phase 10 — Polish & Cross-Cutting

**Goal**: Visual polish, keyboard shortcuts, empty states, and edge cases.

### 10.1 Keyboard Shortcuts

- Tab: agent picker (already partial).
- Ctrl+O: model picker (already partial).
- Ctrl+T: cycle thinking level.
- Ctrl+M: cycle mode.
- Esc: close pickers / cancel turn (already partial).
- Ctrl+L: clear conversation.
- Ctrl+S: open settings.

### 10.2 Empty States

- No models: "No models available. Check your provider configuration."
- No agents: "Only the Atlas orchestrator is available."
- No sessions: "No saved sessions. Start a conversation to create one."
- No task: "No active task. Start a conversation to begin."
- No MCP servers: "No MCP servers configured. Add one from the catalog."

### 10.3 Loading States

- Skeleton cards while `getModels` / `getAgents` / `getMcpStatus` load.
- Spinner on send button while turn is running.
- Disabled controls during active turn.

### 10.4 Error States

- Bridge errors show inline notice with retry button.
- Provider errors show in chat as error bubbles.
- Config errors show in settings with path to fix.

### 10.5 Visual Polish

- Smooth transitions on panel open/close (150ms ease).
- Hover states on all interactive elements.
- Focus rings on keyboard-navigable elements.
- Consistent spacing (8px grid).
- Scrollbar styling to match Atlas theme.

### Files touched

- `packages/vscode/src/ui/main.tsx` — keyboard handler, empty states,
  loading states.
- `packages/vscode/src/ui/styles.css` — transitions, hover, focus,
  scrollbar, skeletons.

### Acceptance criteria

- All keyboard shortcuts work.
- All empty states show helpful messages.
- Loading states show skeletons/spinners.
- Errors are recoverable where possible.
- Visual polish is consistent with Atlas brand.

---

## Summary — Phase Dependency Graph

```
Phase 1 (Header Chips)
  ↓
Phase 2 (Model Picker) ← can parallel with Phase 3
  ↓
Phase 3 (Agent Picker Polish)
  ↓
Phase 4 (Thinking & Mode Pickers) ← depends on Phase 1 chips
  ↓
Phase 5 (Settings /config Alignment)
  ↓
Phase 6 (MCP Catalog) ← can parallel with Phase 7
  ↓
Phase 7 (Task & Workflow)
  ↓
Phase 8 (Token Usage & Cost) ← can parallel with Phase 9
  ↓
Phase 9 (Skills, Tools, Compaction)
  ↓
Phase 10 (Polish & Cross-Cutting)
```

## New Bridge Requests Needed (cumulative)

| Phase | Request | Params | Response |
|---|---|---|---|
| 1 | `getMode` | — | `{ mode: 'plan' \| 'build' \| 'autopilot' }` |
| 1 | `setMode` | `{ mode }` | `{ ok: true }` |
| 1 | `setThinking` | `{ level: ThinkingLevel }` | `{ ok: true }` |
| 4 | `getThinkingLevels` | — | `{ active, available }` |
| 7 | `setPhase` | `{ phase }` | `{ ok: true }` |
| 7 | `skipPhase` | — | `{ ok: true }` |
| 7 | `abortTask` | — | `{ ok: true }` |
| 9 | `getSkills` | — | `{ skills: SkillSummary[] }` |
| 9 | `setSkillEnabled` | `{ name, enabled }` | `{ ok: true }` |
| 9 | `setToolApproval` | `{ name, approval }` | `{ ok: true }` |
| 9 | `getLearnStatus` | — | `{ enabled: boolean }` |
| 9 | `setLearn` | `{ enabled }` | `{ ok: true }` |

Most other data already flows through existing `getStatus`, `getSettings`,
`getModels`, `getAgents`, `getMcpStatus`, `getSessions`, `getTaskStatus`,
`getTodos`, and `updateSettings` requests.

## Files That Will Be Touched Across All Phases

- `packages/vscode/src/ui/main.tsx` — every phase.
- `packages/vscode/src/ui/styles.css` — every phase.
- `packages/vscode/src/bridge.ts` — phases 1, 4, 7, 9.
- `packages/vscode/src/bridge.test.ts` — phases 1, 4, 7, 9.
- `packages/vscode/src/extension.ts` — phases 1, 4, 7, 9.
- `packages/vscode/src/session-host.ts` — phases 1, 4, 7.
- `context/vscode-extension-plan.md` — update after each phase.
- `context/progress-tracker.md` — update after each phase.