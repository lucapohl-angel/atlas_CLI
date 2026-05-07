# Atlas — Progress Tracker

> Update this file after every meaningful change that lands on `main`.
> One short entry beats a long absence. Keep "Recent Decisions" pruned
> to the last ~25 entries; older history lives in `git log` and
> `CHANGELOG.md`.

## Current track

**Post-1.0 SDD pipeline**, plus a parallel **performance &
token-optimization** track on top of it.

- 1.0 phases 0–12: ✅ all shipped.
- Post-1.0 phases 1–11: ✅ all shipped. Phase 12 (installer + module
  system) is **deferred**.
- Performance track: ✅ items 1–6 shipped (commit `30e657d`). See
  **Recent Decisions** below.

## Current Phase

- Maintenance + cross-cutting polish on top of completed phases.

## Current Goal

- Stabilize the OpenTUI-only runtime, first-class OpenCode Zen/Go provider
  support, and the first VS Code extension host skeleton.

## In Progress

- 1.7.3 prep: OpenTUI is the only maintained full-screen TUI, with hosted
  Atlas Power modes, local-model mode controls, prompt-cache labels, and
  OpenCode Zen/Go provider wiring plus a dismissible npm update notice.
- VS Code extension Phase 2.B: `packages/vscode` now has a local session host
  and `Atlas: Run Turn` smoke path; VS Code-native tools are still pending.

## Next Up (recommended order)

1. **Local-model provider via Ollama** — auto-detect
   `http://localhost:11434`, expose any user-pulled model in
   `/model`, add `/local` slash command for zero-config UX. Also
   serves any OpenAI-compatible endpoint (LM Studio, vLLM,
   llama.cpp) via `providers.local.baseUrl`.
2. **VS Code extension Phase 2.B tools** — replace generic core filesystem /
  edit / terminal tools with VS Code-native adapters.
3. Wire a hook (or contributor docs) so `progress-tracker.md` gets a
   one-liner appended automatically after each commit on `main`.
4. Pull the performance-track items into `CHANGELOG.md` under an
   `Unreleased` heading.
5. Decide: do we resurrect post-1.0 phase 12 (installer + module
   system), or formally close it as out of scope and update the README
   phase table to "🚫 deferred"?
6. Audit existing tools for `whenToUse` / `outputContract` /
   `blockedOps` / `examples` completeness — anything missing reduces
   tool-routing quality.
7. Wire `routerModel` into the remaining background paths
   (`summarizeToolArgs` in the TUI, todo extraction, slash-parsing
   helpers) — only compaction + skill-learning reflection are wired
   today.

## Open Questions

- Should the `read_file` cache be persisted across sessions (e.g. in
  `~/.atlas/cache/`)? Today it's purely in-memory.
- Do we want a project-state-file dirty-bit so `recommendNext` can skip
  the full filesystem walk on cold start?
- DESIGN.md `@google/design.md` upstream is at v0.1.0 — when 0.2 ships,
  what's our policy on breaking changes? (See AGENTS.md "Protected
  files".)
- Lint is wired through `pnpm lint`: repo text hygiene plus per-package
  TypeScript checks. A future ESLint adoption remains optional if we want
  semantic style rules beyond strict TS.

## Recent Decisions

> Append newest at the top. One line each: `[shortsha] one-line summary`.

- `[pending]` OpenTUI is the only maintained TUI; OpenCode Zen/Go BYO-key
  providers are wired through config, catalog, runtime, and `/config`.
- `[pending]` VS Code extension Phase 2.A starts in `packages/vscode` with a
  local side-bar webview host and typed bridge.
- `[pending]` VS Code extension Phase 2.B smoke path runs one local Atlas core
  turn from the command palette or side-bar bridge.
- `[pending]` Atlas checks npm on TUI open and shows a dismissible update
  notice when `atlas-os` is behind.
- `[e02d9b7]` workspace installs OpenTUI native optional deps for all release
  targets and package metadata points at `ATLAS_OS`.
- `[371ef5b]` terminal tool now kills POSIX process groups on timeout/abort,
  fixing CI shell-child hangs.
- `[9f4d19c]` workflows now let `pnpm/action-setup` use the pinned
  `packageManager` version, fixing release/CI setup.
- `[2d76cf9]` v0.1.6 final cleanup: fresh startup splash by default,
  public README refresh, and local/private artifact ignores.
- `[975523f]` v0.1.6 release prep: OpenTUI polish, inherited subagent approvals,
  lint/pnpm gates, and release workflow quality checks.
- `[30e657d]` perf: 6 token/perf optimizations — Anthropic
  `cache_control` markers, head+tail tool-result truncation,
  `edit_file` tool, `routerModel` cheap-model router, sliding-window
  compaction with stale-tool-result pre-pass, `read_file` mtime+size
  cache.
- `[35a3b05]` `/sessions` TUI picker gains multi-select, rename, and
  delete-all.
- `[5618ca3]` `/sessions` TUI picker — open or delete from the list.
- Earlier history: see `CHANGELOG.md` and `git log --oneline`.

## Architecture Decisions of record

> Decisions that affect system shape — keep terse, link out for detail.

- **Result over throw** for control flow.
  ([code-standards.md](./code-standards.md) § Async + cancellation,
  [errors.ts](../packages/core/src/errors.ts))
- **Zod at every I/O boundary** (config, tool input, provider response,
  MCP message). No untyped objects in business code.
- **Templates / checklists / workflows are typed engines, not
  megaprompts.** Schema-validated YAML, fail-fast on missing required
  inputs. ([ARCHITECTURE.md](../ARCHITECTURE.md) § SDD pipeline)
- **Customization overlays**: built-in → user (`~/.atlas/`) → project
  (`<cwd>/.atlas/`) deep-merge.
- **Prompt caching markers go on stable content only** (system prompt,
  last static tool). Dynamic per-turn content is never marked. Cache
  tokens roll into `promptTokens` and report separately as
  `cacheReadTokens` / `cacheCreationTokens`.
- **Tool `summary` is the only field that reaches the model.** Bulk
  content stays in `data.*` and gets head+tail truncated for the
  summary; the agent-loop carries a 32 KB safety backstop.
- **Compaction is sliding-window-keep-recent + summary-of-rest**, with
  a cheap `pruneStaleToolResults` pre-pass that often skips the LLM
  call entirely.
- **Cancellation everywhere.** Single `AbortController` per turn,
  threaded through provider streams, tool execution, and hooks.

## Session Notes

> Scratch space for resuming work in the next session. Wipe when stale.

- The internal project context system (`context/*.md`) was adopted on
  2026-05-03. Atlas already ships the industrialized version of this
  discipline (templates / checklists / workflows / stories / handoffs);
  the context files exist so Atlas itself dogfoods it.
- The `routerModel` config knob exists but is only wired into
  compaction and skill reflection so far — see "Next Up" #5.
- Lint is wired at the workspace root; `pnpm lint` is part of the release
  quality gate.
