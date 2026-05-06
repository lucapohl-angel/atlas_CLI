# Atlas — Project Overview

> Product spec for **Atlas CLI** itself. Treat this as the single source of
> truth for what Atlas *is*, who it's for, and what's deliberately out of
> scope. When a story or implementation step is ambiguous, resolve against
> this file before guessing.

## Overview

Atlas is a terminal-first AI coding agent that orchestrates a crew of
specialized sub-agents — named after the Greek pantheon — through the full
software lifecycle: requirements, architecture, story breakdown,
implementation, QA, and delivery. It is **model-agnostic** (defaults to
OpenRouter; first-class Anthropic / OpenAI / Codex / Claude-Code
OAuth), **hook-driven** (typed pre/post lifecycle events with real blocking
semantics), and **skill-extensible** (on-demand `SKILL.md`
loaded by the active agent based on context).

## Goals

1. Ship a working CLI at every phase boundary — never leave the tree in a
   partial state. (`pnpm typecheck && pnpm test:run` clean before a phase
   is marked done.)
2. Stay model-agnostic. No provider lock-in. New providers plug into the
   `Provider` interface without touching the loop.
3. Run safely on a developer's box: SSRF-guarded `web_fetch`, terminal
   tool with cancellation, no `&`/`nohup` backgrounding, secrets only via
   config or env.
4. Beat the cost curve through prompt caching (Anthropic `cache_control`,
   OpenRouter / Codex cached-token tracking), tool-result truncation
   (head+tail), in-memory `read_file` cache keyed by `(path, mtime, size)`,
   and a configurable cheap-model `routerModel` for low-stakes side work.
5. Adopt the spec-driven-delivery (SDD) playbook by *industrializing* it —
   typed templates with elicitation gates, checklists with severity
   verdicts, declarative workflow chains, project-state-aware routing.
   Atlas is the factory; user docs are the output.

## Core User Flow

1. `pnpm install && pnpm build`
2. Set `OPENROUTER_API_KEY` (or `ANTHROPIC_API_KEY`, or run
   `atlas claude-code login` for OAuth).
3. `atlas init` — installs Greek-pantheon agents + starter skills under
   `~/.atlas/`.
4. `atlas chat` — opens the full-screen TUI. The orchestrator picks the active
   agent based on detected project state (PRD present? stories?
   uncommitted? active story status?).
5. User issues a slash command (`/agent`, `/model`, `/skills`,
   `/sessions`, `/learn`, …) or just talks. The active agent's persona
   drives tool calls; hooks gate side effects; sessions persist to
   `~/.atlas/sessions/`.
6. At handoff points (PRD done → architecture; story done → QA, …)
   `atlas *next` consults the handoff queue → chain table → state
   fallback and proposes the next agent. User accepts, skips, or goes
   manual.
7. Token usage, cache hits, and provider/model are surfaced live in the
   header. Sessions auto-compact at the configured threshold using a
   sliding-window-keep-recent + summary-of-rest strategy with a stale
   tool-result pre-pass.

## Features (shipped)

### Core runtime

- Streaming providers (Anthropic, OpenAI Responses/Codex, OpenRouter,
  Claude-Code OAuth) with prompt-caching support and `cache_*` token
  reporting.
- Tool registry with Zod-typed inputs, three approval modes
  (`auto` / `ask` / `never`), `AbortSignal` cancellation everywhere,
  per-tool `whenToUse` / `outputContract` / `blockedOps` / `examples`.
- Built-in tools: `read_file` (cached), `write_file`, `edit_file`
  (surgical exact-match), `terminal`, `web_fetch` (SSRF-guarded),
  `web_search`, `browser`, `git`, `gh`, `delegate`, todo/clarify/story/
  handoff/template/checklist/workflow tools.
- Hooks engine with `allow` / `block` / `modify` results, matchers per
  event.
- Skills loader (`~/.atlas/skills/<name>/SKILL.md`), versioned, on-demand
  via `skill_view`.
- Agents loader (`~/.atlas/agents/<name>/AGENT.md`), exactly one active
  at a time, persona injected into system prompt.
- Orchestrator: pure project-state detector + decision function;
  recommendation source discriminator (`handoff` / `chain` / `state`).
- Sessions: persistent JSON transcripts + audit log + `/sessions` TUI
  picker (multi-select rename / delete / delete-all).
- Context window manager: auto-compaction at threshold, sliding-window
  keep-recent, stale-tool-result pre-pass.
- MCP client (stdio).

### SDD pipeline (post-1.0)

- Templates engine (Handlebars-over-YAML, owner enforcement,
  elicitation gates) + 16 starter templates.
- Checklists engine with `blocker`/`warning`/`info` severity + 17
  starter checklists.
- DESIGN.md adoption pegged to `@google/design.md` v0.1.0.
- Workflow chains (`chains.yaml`) with built-in → user → project
  overlay, handoff queue.
- Project state file (`<cwd>/.atlas/state.yaml`).
- Workflow gates + activation hooks (`requires` + activation metadata).

## In Scope

- Terminal/TUI host (Ink).
- Local filesystem state under `~/.atlas/` and `<cwd>/.atlas/`.
- Provider streaming, tool execution, hooks, skills, agents,
  orchestrator, sessions, context, MCP stdio.
- Spec-driven-delivery primitives (templates, checklists, workflows,
  stories, handoffs, project state).
- Customization overlays: built-in → user → project merge.

## Out of Scope (for now)

- Web UI / browser-hosted Atlas. The architecture supports it
  (`@atlas/core` is host-agnostic) but no host is being built.
- VS Code extension as a first-class deliverable.
- MCP HTTP transport (only stdio is supported today).
- Hosted SaaS / multi-tenant Atlas.
- Telemetry / analytics back-end.
- Bundling a tokenizer (we use `~chars/4` approximation; hosts can
  override `TokenCounter`).
- Installer + module marketplace (post-1.0 phase 12, deferred).
- LLM-driven design generation that bypasses DESIGN.md byte-spec.

## Success Criteria

1. `node packages/cli/dist/bin/atlas.js doctor` passes on a clean clone
   after `pnpm install && pnpm build`.
2. `atlas chat` starts the TUI, lists installed agents, and streams a
   reply against the configured provider with no warnings to stderr.
3. `atlas init` populates `~/.atlas/agents/` with the Greek pantheon and
   `~/.atlas/skills/` with the starter skills.
4. `atlas status` correctly reports the recommended agent for an empty
   repo, a repo with `docs/prd.md`, and a repo with an in-progress
   story.
5. Every shipped phase row in [README.md](../README.md) is accompanied
   by passing `pnpm --filter @atlas/core test:run` and
   `pnpm --filter atlas-os test:run` runs.
6. No `any`, no thrown control-flow exceptions, no missing
   `AbortSignal` on long-running async — verified by code review and
   strict TS settings.

## Non-goals (philosophy)

- **Don't try to outsmart the model with prose.** Ship typed engines,
  not megaprompts. Templates / checklists / workflows are data with
  schema, not freeform markdown.
- **Don't reinvent BMAD.** See `ARCHITECTURE.md` § Comparison. We
  diverge deliberately on stack, format, and enforcement.
- **Don't auto-update the user's tree without their consent.** Every
  destructive action goes through hooks or approval prompts.
