# Changelog

All notable changes to Atlas CLI are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
semantic versioning.

## [Unreleased]

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
