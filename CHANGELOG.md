# Changelog

All notable changes to Atlas CLI are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
semantic versioning.

## [Unreleased]

## [1.7.2] - 2026-05-06

### Added
- `/config` now includes hosted Atlas power modes: Atlas Power Full and Atlas
  Smart Mode, with cost estimates plus pros and cons.
- Model catalogs now carry prompt-cache support metadata, and model pickers
  show cache labels so users can choose cheaper cache-capable models. OpenRouter
  cache labels are derived from live `/models` cache-pricing fields.
- `/models` now shows a visible type-to-filter search field in the grouped
  model picker.
- `/sessions` now supports multi-select and delete-all cleanup for saved
  transcripts.
- The TUI top bar now shows the active hosted Atlas mode with bright Full/Smart
  badges.

### Changed
- Package metadata is prepared for the `atlas-os@1.7.2` release line.

### Fixed
- Exiting the TUI now restores the terminal cleanly, prints the Atlas OS
  wordmark, and avoids OpenTUI `EditBuffer is destroyed` teardown stacks.

## [1.7.1] - 2026-05-06

### Added
- OpenTUI local-model setup now exposes Lite, Hybrid, and Full Atlas modes
  from `/config -> Local models`, with hardware guidance and short pros/cons
  for each mode.
- Local Hybrid mode keeps a compact Atlas prompt while advertising only the
  core development tool allowlist for small local models.

### Changed
- Local provider config now writes `providers.local.toolMode` while preserving
  the legacy `liteMode` alias for existing configs.

### Fixed
- OpenTUI now preserves the local provider mode through startup/model switching,
  and compact local prompts keep Atlas identity plus the exact active model id.
- The compiled OpenTUI binary bundles the React binding consistently for local
  model runs.

## [0.1.7] - 2026-05-06

### Changed
- Documentation and source comments no longer attribute design ideas to
  external projects; wording is now neutral and Atlas-specific.

## [0.1.6] - 2026-05-05

### Added — OpenTUI, delegation, and release-readiness polish
- OpenTUI becomes the default full-screen runtime, with clearer fallback
  messaging for the classic Ink UI and provider-connection warnings in
  the header/splash when no key is configured.
- OpenTUI now mirrors more of the Ink workflow: build-mode tool approval
  prompts, live sidebar todos, session/context token accounting,
  manual/forced learned-skill drafting with review/change/save flows,
  smarter `/compact`, and existing-doc reuse in `/onboard`.
- Startup model selection now prefers explicit `--model`, resumed-session
  model, connected configured defaults, then connected catalog fallbacks.
- Delegated subagents now inherit the parent approval policy, so plan,
  build, and autopilot semantics remain consistent in child loops.
- Atlas coding agents now receive an explicit verification habit: discover
  project-specific lint/typecheck/test/build gates from local repo docs and
  scripts, run the relevant gates, and avoid treating lint as a universal
  hardcoded Atlas command.

### Changed
- Root `pnpm lint` is now wired and quiet on Linux/Garuda: it runs repo
  text hygiene checks plus `tsc --noEmit` for `@atlas/core` and `atlas-os`.
- Development docs now state the pnpm requirement and include `pnpm lint`
  in the documented release quality gate.
- CI and release tag builds now run the lint gate as part of quality
  verification before publishable artifacts are produced.
- Atlas now starts on a fresh splash/transcript by default; saved sessions
  are reopened only through explicit `--resume`, `/resume`, or `/sessions`.
- Public README copy now matches the supported provider set and documents
  install, provider setup, greenfield/brownfield flows, and advanced tweaks.

### Fixed
- Anthropic message translation now drops empty assistant turns instead of
  sending invalid empty text blocks after interaction-only turns.
- OpenTUI resumed sessions no longer render empty assistant rows for stripped
  interaction requests.
- Root `npm install` at the private workspace now stops early with pnpm setup
  instructions instead of creating broken workspace state.

### Added — Post-1.0 Phase 11 (Customization overlays)
- Loader precedence is now consistent across core config artifacts:
  built-in defaults → `~/.atlas` user overrides → `<cwd>/.atlas` project
  overrides.
- Applied overlay merge strategy to workflows, templates, checklists,
  and agents, so project-local definitions can override user defaults
  without forking the whole built-in set.

### Added — Post-1.0 Phase 10 (Workflow gates + activation hooks)
- `chains.yaml` gains optional `requires` gates (project-state and
  state-file predicates) and optional `activation` metadata
  (`prepend`, `append`, `persistent_facts`, `on_complete`).
- `recommendNext` now evaluates chain gates before routing and can
  fall back to `.atlas/state.yaml` story signals (`source: state-file`).
- Built-in workflow chains now include activation defaults and gate
  hints for key transitions.
- Added onboarding primitives in `@atlas/core/onboarding`:
  `estimateOnboardCost` (preflight token/cost envelope) and
  `writeRepoMap` (deterministic repo map artifact for map-only flow).
- TUI adds `/onboard` wizard (arrow-key flow) with mode selection,
  cost-reduction strategy selection, per-stage model selection, and
  map-only execution path.

### Added — Post-1.0 Phase 9 (Project state file)
- New `@atlas/core/state` module — typed loader/saver for
  `<cwd>/.atlas/state.yaml`, the BMAD `sprint-status.yaml` analogue.
  Tracks epic and story status across the SDD pipeline
  (`draft → ready-for-dev → in-progress → review → done`, plus `blocked`).
- Public API: `loadProjectState`, `saveProjectState`, `parseProjectState`,
  `upsertEpic`, `upsertStory`, `setStoryStatus`, `setEpicStatus`,
  `findFirstStoryByStatus`, `summarizeProjectState`.
- Missing file is a legal empty default (zero-config). File is
  human-editable YAML with a header comment explaining ownership
  (Hestia / Hercules / Nemesis / Hermes).
- New error codes: `STATE_PARSE_FAILED`, `STATE_WRITE_FAILED`,
  `STATE_STORY_NOT_FOUND`, `STATE_EPIC_NOT_FOUND`.

### Added — Post-1.0 Phase 8 (Sectioned long-form templates)
- `renderTemplateSection` — render a single top-level section of a
  template, honoring owner enforcement, elicit gates, conditionals,
  and repeatables. Returns body content with no preamble or title.
- `applySectionToFile` / `readSectionFromFile` — idempotent,
  marker-based section writes (`<!-- atlas:section <id> -->` …
  `<!-- /atlas:section <id> -->`). Append on first write, in-place
  replace on subsequent writes; preserves order of other sections.
- New error codes: `TEMPLATE_SECTION_NOT_FOUND`,
  `TEMPLATE_SECTION_WRITE_FAILED`. Enables long-form artifacts
  (PRD, architecture) to grow section-by-section across multiple
  agent turns without rewriting the whole document.

### Added — Post-1.0 Phase 7 (Docs + examples)
- README phase table extended with the post-1.0 SDD pipeline track
  (phases 1–11; phase 12 deferred).
- `ARCHITECTURE.md` gained an "SDD pipeline (post-1.0)" section
  documenting templates, checklists, workflows, stories, and project
  state engines.
- `ARCHITECTURE.md` gained an "Atlas vs BMAD-METHOD" comparison table
  capturing where Atlas already differs and what phases 8–11 will close.
- New `examples/sdd-walkthrough.md` — end-to-end run of the Greek-god
  pipeline on a fictional product (brief → PRD → architecture → UX →
  design system → epic → story → implementation → QA), showing every
  built-in template, checklist, and chain transition along the way.

### Added — Post-1.0 Phase 6 (Skill versioning + `*next`)
- Skill loader deduplicates by name with newest `createdAt` winning.
- `/skills` slash command toggles individual skills on/off without
  removing them.
- `atlas *next` shells the orchestrator's recommendation, including the
  source (`handoff` / `chain` / `state`) and reason.

### Added — Post-1.0 Phase 5 (Workflow chains + handoff orchestrator)
- New `workflows/` module: `ChainStepSchema`
  (`fromAgent` / `command?` / `toAgent` / `nextCommand?` / `reason?`),
  `ChainsFileSchema`, `parseChains`, `loadChains`, `lookupChain`.
- `loadChains` resolution order: explicit `dir` →
  `<cwd>/.atlas/workflows/chains.yaml` →
  `~/.atlas/workflows/chains.yaml`. Missing files silently fall through.
- `recommendNext({ cwd, fromAgent, lastCommand })` returns
  `{ source: 'handoff' | 'chain' | 'state', agent, command?, reason? }`.
  Priority: pending handoff queue (oldest unconsumed) → chain table →
  static `recommendAgent(state)` fallback.
- Built-in `workflows/chains.yaml` encoding the canonical Greek-god
  pipeline (athena → prometheus → aphrodite → hermes → hestia →
  hercules → nemesis → … plus the iris/apollo fan-in).
- `atlas status` rewritten to surface `pending handoffs`, the
  recommended next agent, and the source/reason. JSON mode includes the
  full handoff list.

### Added — Post-1.0 Phase 4 (Checklists + DESIGN.md adoption)
- New `checklists/` module: typed runner with per-item severity
  (`blocker` / `warning` / `info`), aggregate counts, and a
  `verdict: pass | fail` derived from blocker fails only.
- 17 starter checklists shipped: 14 per-template (one per artifact) plus
  3 cross-cutting (`security-review`, `definition-of-done`,
  `release-readiness`).
- `design-system` template emits a v0.1.0-spec-compliant `DESIGN.md`
  with frontmatter + canonical section order; locked by a render-time
  byte-spec conformance test.
- `npm` is now a declared engine requirement (root `package.json`) so
  Aphrodite can shell out to `npx @google/design.md lint DESIGN.md`
  unconditionally; persona body updated to remove the prior "if Node is
  available" caveat.

### Added — Post-1.0 Phase 3 (Templates engine + 16 starter templates)
- New `templates/` module: `TemplateSchema` (id/version/owner/editors/
  inputs/output/whenToUse/preamble/sections), Handlebars compiler, owner
  enforcement (`TEMPLATE_OWNER_MISMATCH`), elicitation gate
  (`TEMPLATE_INPUT_MISSING`), conditional sections, repeatable sections.
- 16 built-in templates (`product-brief`, `prd`, `architecture`, `epic`,
  `story`, `ux-spec`, `design-system`, `release-notes`, `adr`,
  `bug-report`, etc.) embedded as strings, written by `atlas init`.

### Added — Post-1.0 Phase 2 (Tool quality)
- All built-in tool descriptions extended with `whenToUse`, `contract`,
  `blockedBy`, and concrete `examples` so the model picks the right
  tool the first time.

### Added — Post-1.0 Phase 1 (Persona DNA)
- `AgentFrontmatterSchema` extended with `voiceDna`, `activation`,
  `capabilityBoundaries`, `dataRefs`, `examples`, `templates`,
  `checklists`, `authorizedSections`, `forbiddenSections`,
  `personaAlias`, `kind` (`framework` / `user`).
- `buildSystemPrompt` renders these into clearly-labelled sections so
  the model produces output that *sounds* like the persona, not just
  talks about being it.
- All 9 framework agents (athena, prometheus, aphrodite, hermes, hestia,
  hercules, nemesis, iris, apollo) enriched with full DNA.

### Added — Phase 12 polish (post-1.0 wiring)
- **Self-improvement loop (learned skills)** — Atlas now
  watches each turn and, when a heuristic fires (≥5 rounds, ≥2 tool
  errors, or a success phrase after a struggle), runs a one-shot
  reflection sub-call against the active provider asking it to distill
  a procedurally reusable lesson into a draft `SKILL.md`. The draft
  surfaces in a confirmation overlay showing **what it does**, **why
  it was created**, the trigger keywords, and a body preview, with
  Save / Discard. Saved skills land in `~/.atlas/skills/<slug>/SKILL.md`
  with `kind: learned` frontmatter and are scoped to framework agents
  only — they are NOT exposed to user agents and not slash-invokable.
  New `/learn [on|off|status]` command for manual control.
  Token cost is bounded: the existing skill index is one line per
  skill (lazy-loaded bodies via `skill_view`), so adding 50 learned
  skills adds ~600 tokens per turn; reflection only runs when the
  heuristic gate fires.
- **Resume actually shows prior messages** — `/resume <id>` and the
  session picker now rehydrate the visible transcript from the saved
  message list (previously only the next turn had history; the screen
  was empty). User/assistant messages reappear, tool calls render as
  `→ name(args)` lines and tool results as `← name: result` lines.
- **Session id label** — header now shows `· session <full-id>` instead
  of the bare last-12 characters of the slug.
- **Exit shortcut moved from Ctrl-C to Ctrl-D** — pressing
  Ctrl-D twice within 1s now exits atlas (standard shell-style EOF).
  Ctrl-C is now a single-press stream cancel only and is a no-op when
  idle, so it no longer competes with the terminal emulator's
  copy-on-Ctrl-C behaviour. Status bar and welcome screen updated.- **Real GitHub OAuth via Device Flow** — picking *OAuth via browser*
  in the GitHub MCP auth menu now runs the standard device-code flow:
  Atlas requests a short user code, opens
  `https://github.com/login/device` in your browser, and polls until
  you sign in, type the code, and click **Authorize**. The access
  token is captured automatically — no PAT to create or paste. Esc
  cancels at any time. Defaults to GitHub CLI's well-known public
  client_id (consent screen reads "GitHub CLI"); set
  `ATLAS_GITHUB_CLIENT_ID` to use your own registered OAuth App.
- **Custom MCP server flow with sandboxed AI helper** — the `/mcps add`
  picker now ends with a `custom…` row that opens a sub-menu:
  *Manual* prints concise YAML instructions for `~/.atlas/config.yaml`,
  and *Ask AI* opens a freeform prompt ("add the linear mcp server")
  that runs a tightly-scoped agent loop. The harness has exactly two
  tools — `web_fetch` (HTTPS only, 16 KB body cap) and
  `add_mcp_server` (single call, writes one entry into the user
  config) — with a system prompt forbidding anything else (no shell,
  no other research, refuses unrelated requests). Capped at 8 rounds.
  Once the entry lands, transitions straight into the existing
  restart-required overlay. Esc cancels the loop.
- **Already-installed catalog entries are hidden from `/mcps add`** —
  picking from the curated list no longer shows servers you've already
  configured (use `/mcps` to manage them instead). Replaces the prior
  green "connected" tag.

- **`/mcps` is now an interactive overlay, not a chat dump** — the
  bare `/mcps` command opens a TUI list of all configured servers
  with a green dot for connected (and tool count), yellow circle
  for disabled, and a red mark for failed. Selecting a server opens
  a per-server actions overlay with Enable/Disable, Remove (hidden
  for built-ins like `memory`), and Back. Replaces the easy-to-miss
  text printout. The list also has a "+ Add new server…" entry that
  jumps straight into the add picker.
- **Add picker no longer errors on already-configured servers** —
  catalog entries that are already installed now show a green
  `• connected` tag and selecting them opens the per-server manage
  overlay (instead of the old "remove it first with /mcps remove …"
  error message).
- **Built-in MCP servers cannot be accidentally removed** — the
  seeded `memory` server (and any future built-ins listed in
  `DEFAULT_BUILTIN_MCP_SERVERS`) only expose Enable/Disable in the
  manage overlay and reject `/mcps remove`. They can still be
  toggled off without losing their config.
- **Restart-required prompt after `/mcps add`** — saving a new MCP
  server now opens a dedicated overlay (`'X' added — restart required`)
  with two clear options: quit now to restart, or keep chatting (and
  the new server's tools won't be available until the next launch).
  Replaces the easy-to-miss chat-line message.
- **GitHub MCP gets a third auth option: OAuth via browser** — opens
  https://github.com/settings/personal-access-tokens/new (with the
  description prefilled) so the user can review scopes and create a
  fine-grained token, then drops them into the paste step. Keeps the
  existing gh-CLI and PAT options. Suggestions schema gained
  `oauthBrowserUrl` for reuse.
- **github-mcp-server auto-installer** — the prereq overlay for the
  GitHub MCP server now offers "Install for me", which downloads the
  latest release tarball for the user's OS/arch (Linux + macOS, both
  x86_64 and arm64) into `~/.local/bin` and chmods it. `findOnPath`
  now also probes `~/.local/bin` so the recheck step succeeds even if
  the user's shell hasn't picked it up. The MCP add flow stores the
  resolved absolute path in `~/.atlas/config.yaml` so spawning works
  on next start regardless of PATH.
- **GitHub MCP auth picker (OAuth or PAT)** — picking `github` in
  `/mcps add` now opens an auth-method chooser. **OAuth** shells out
  to `gh auth token` (requires the `gh` CLI installed and signed in)
  and stores the returned token as `GITHUB_PERSONAL_ACCESS_TOKEN` —
  no copy-paste, scopes follow your `gh auth login` session. **PAT**
  keeps the existing flow (paste a `ghp_…` / `github_pat_…` token).
  A third option opens cli.github.com if `gh` isn't installed yet.
  Suggestions now expose optional `authMethods` + `oauthEnvKey` so
  this pattern can be reused for other servers later.
- **`/compact model` (no id) opens the model picker** — picking a model
  now scopes to compaction (persists `compaction.model` in
  `~/.atlas/config.yaml`) instead of switching the chat model. The
  picker title changes to make the scope explicit.
- **`/mcps enable <name>` and `/mcps disable <name>`** — toggle the
  `enabled` flag on any configured MCP server without removing it. The
  `/mcps` list footer now mentions the new commands.
- **Pricing tags + narrowed catalog** — `/mcps add` now shows a
  `[free|byo|freemium|paid]` tag next to each entry and the curated
  list is reduced to four high-signal servers: filesystem (free),
  github (byo), higgsfield (paid), figma (freemium). Power users can
  still edit `~/.atlas/config.yaml` directly to add anything else.
- **Memory MCP enabled by default** — fresh installs are seeded with
  `@modelcontextprotocol/server-memory` so the agent has persistent
  notes across sessions out-of-the-box. A new `mcp.builtinsSeeded`
  flag prevents re-seeding if the user later removes it.
- **Prerequisite detection at `/mcps add`** — when the user picks an
  stdio entry whose required runtime (`npx`, `uvx`, `github-mcp-server`)
  isn't on PATH, Atlas now opens a dedicated overlay with: install for
  me (only for vetted-safe installers — currently `uv`'s official
  `curl|sh`), re-check, open install docs, or skip. New `findOnPath`
  helper in `@atlas/core` does cross-platform PATH lookup without
  shelling out to `which`.
- **GitHub MCP swapped to standalone binary** — replaces the previous
  Docker-based entry. `github-mcp-server stdio` is a single static Go
  binary from github/github-mcp-server releases (no Docker daemon, no
  kernel modules, prebuilt for linux/macOS/windows).
- **Auto-compaction with `/compact` controls** — when the running token
  count crosses `compaction.threshold` (default 0.8 of 200k), Atlas
  asks a model to roll older turns into a single summary system message
  before the next turn fires. By default the **active** chat model does
  the summarization (no separate dependency); set `compaction.model` in
  `~/.atlas/config.yaml` or run `/compact model <id>` in the TUI to
  pin a cheaper summarizer. Other slash commands: `/compact` (force
  now), `/compact status`, `/compact on|off`, `/compact threshold <v>`.
- **MCP HTTP transport (Streamable HTTP, spec 2025-03-26)** — `McpClient`
  is now transport-agnostic via the new `McpTransport` interface. Stdio
  is one impl (`StdioTransport`), HTTP is another (`HttpTransport`).
  HTTP supports JSON or SSE responses, header-based auth (e.g. `Bearer
  <token>`), `Mcp-Session-Id` lifecycle (echo + drop on 404), and 202
  notifications. Higgsfield + Figma added to the suggestion catalog as
  the first two hosted entries.
- **Sessions: `--resume`, `/resume`, `/sessions`, header session id** —
  the TUI creates a `SessionRecord` on boot (or loads one with
  `--resume <id>` / `--resume` for the latest), persists messages to
  `~/.atlas/sessions/<id>.json` after every turn, and exposes `/resume`
  (picker overlay) + `/sessions <id>` (direct load) at runtime. The
  current session id is shown in the header next to the model.
- **MCP runtime spawning** — `runTui` now spawns every `enabled: true`
  server in `~/.atlas/config.yaml` at boot via `startMcpServers()`,
  graft their tools into the agent's `ToolRegistry` under the
  `mcp__<server>__<tool>` namespace, and stops them on exit. The agent
  loop calls them transparently alongside built-in tools.
- **`/mcps add` TUI flow** — pick from a curated catalog
  (`MCP_SUGGESTIONS`: filesystem, fetch, github, brave-search, sqlite,
  memory, time, sequential-thinking, postgres, slack), prompt for any
  required env vars one at a time, persist to `~/.atlas/config.yaml`.
- **`/mcps remove <name>`** — delete a configured server.
- **`/mcps`** — now reports running vs. failed vs. disabled with live
  tool counts, not just a static config dump.
- **Hooks wired into the agent loop** — `runAgentLoop` accepts an
  optional `HookRegistry` and fires `beforeTool` (allow/block/modify),
  `afterTool`, and `afterMessage` at the right points. Phase 4's
  contract is now live, not just a library.

### Added — Phase 0 (Foundation)
- pnpm monorepo: `@atlas/core`, `atlas-os`
- TypeScript strict mode, ESM-only, Vitest
- Pino structured logging
- `Result<T, E>` and `AtlasError` types in `@atlas/core`
- `atlas --version` and `atlas doctor` (diagnostics dump)
- README, ARCHITECTURE, AGENTS, LICENSE
- Vitest test suites for `Result` and `AtlasError`

### Added — Phase 1 (Single-turn streaming chat)
- `AtlasConfig` Zod schema and `loadConfig()` that reads
  `~/.atlas/config.yaml` and applies env overrides
  (`OPENROUTER_API_KEY`, `ATLAS_MODEL`, `OPENROUTER_BASE_URL`,
  `ATLAS_CONFIG`).
- `Provider` interface (`Message`, `StreamEvent`, `TokenUsage`,
  `CompletionRequest`) — vendor-neutral streaming contract.
- `createOpenRouterProvider()` — OpenAI-compatible SSE client with
  typed error mapping (auth, rate-limit, model-not-found, network)
  and full `AbortSignal` propagation.
- `providerFromConfig()` factory wired through `@atlas/core`.
- `atlas ask "<prompt>" [-m model] [-s system] [-t temp]` streams
  tokens to stdout; SIGINT cancels in flight.
- `fallbackModels` config and request field forwarded to OpenRouter
  as the `models[]` array for automatic per-request failover.

### Added — Phase 2 (Interactive REPL)
- `atlas chat` (default command) with `node:readline` REPL.
- Slash commands: `/exit`, `/quit`, `/clear`, `/help`, `/history`,
  `/model <id>`.
- Per-message `AbortController`; Ctrl-C cancels the current stream
  without exiting the REPL.
- Cancelled turns are dropped from history to keep the conversation
  coherent.

### Added — Phase 3 (Tool system)
- `Tool<I>` contract with Zod input validation and Result-typed
  output.
- `ToolRegistry` + `invokeTool()` with three approval modes
  (`auto` / `ask` / `never`) and a pluggable `ApprovalPolicy`.
- Built-in tools: `read_file` (path-escape protection, 200 KB cap),
  `write_file` (creates parent dirs), `terminal` (60 s timeout,
  SIGTERM on cancel, 64 KB stdout/stderr caps).

### Added — Phase 4 (Hook system)
- Typed `HookEvent` discriminated union: `sessionStart`,
  `sessionEnd`, `beforeMessage`, `afterMessage`, `beforeTool`,
  `afterTool`.
- `HookRegistry` + `runHooks()` honoring `allow` / `block` / `modify`
  semantics; thrown handlers are coerced into `block`.
- Optional `matcher` field (string or RegExp) to scope tool hooks.

### Added — Phase 5 (Skills system)
- `SkillFrontmatterSchema` and on-disk format
  (`~/.atlas/skills/<name>/SKILL.md` with YAML frontmatter).
- `loadSkills()` + `SkillRegistry` with case-insensitive substring
  matching against name and triggers.
- `renderSkillIndex()` for system-prompt injection.

### Added — Phase 6 (MCP client)
- `McpClient` over JSON-RPC line-framed stdio: `initialize`,
  `tools/list`, `tools/call`, `notifications/initialized`.
- 30-second per-request timeout, child-process lifecycle managed,
  Zod-validated server responses.

### Added — Phase 7 (Agents)
- `AgentFrontmatterSchema` (name, role, description, model, skills,
  handoffs).
- `loadAgents()` + `AgentRegistry`.
- `buildSystemPrompt(agent, skills)` composes persona, skill index,
  and handoff rules.

### Added — Phase 8 (Orchestrator)
- Pure `detectProjectState(cwd)` — git, PRD, architecture, story
  count.
- Pure `recommendAgent(state)` — maps state to a Greek-god agent.
- `atlas status [--json]` CLI command.

### Added — Phase 9 (Context window)
- `approximateTokenCount` (chars/4 heuristic) + pluggable
  `TokenCounter`.
- `planCompaction()` triggers at 80 % of `contextTokens`, preserves
  system prompt and the last 4 turns.
- `buildCompactPrompt()` and `applyCompaction()` helpers.

### Added — Phase 10 (Sessions)
- `SessionStore` with atomic JSON writes to
  `~/.atlas/sessions/<id>.json`.
- `create`, `write`, `load`, `list`, `latest`, `appendAudit`.

### Added — Phase 11 (Built-ins)
- Eight Greek-god agents shipped as embedded `AGENT.md` strings:
  Athena, Prometheus, Hestia, Hercules, Nemesis, Iris, Apollo,
  Aphrodite.
- Three starter skills: `write-tests-first`, `small-diffs`,
  `cancellation-everywhere`.
- `atlas init [--force]` writes them to `~/.atlas/`.

### Added — Phase 12 (Polish)
- README phase table updated through Phase 12.
- This changelog brought to date.
- `prepublishOnly` build hook on each publishable workspace.
