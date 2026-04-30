# Changelog

All notable changes to Atlas CLI are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
semantic versioning.

## [Unreleased]

### Added — Phase 12 polish (post-1.0 wiring)
- **Real GitHub OAuth via Device Flow** — picking *OAuth via browser*
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
- pnpm monorepo: `@atlas/core`, `atlas-cli`
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
