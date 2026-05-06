# Atlas CLI — Architecture

> This document describes the design of Atlas. It is the source of truth for
> how the pieces fit together. If code disagrees with this document, fix
> whichever is wrong (and update both if the design has evolved).

## Goals

1. **Multi-agent**: a crew of personas (Greek gods) handles different phases
   of the software lifecycle.
2. **Hook-driven**: typed lifecycle events (`beforeTool`, `afterTool`, etc.)
   with real blocking semantics, so guardrails are enforced — not suggested.
3. **Model-agnostic**: OpenRouter is the default and supports any of its
   hundreds of models. Anthropic and OpenAI can also be configured directly.
4. **Skill-extensible**: on-demand skills loaded by the active
   agent when triggered by context.
5. **Beginner-friendly**: project state detection drives automatic agent
   selection, with clear visual indication of who is active and why.

## Packages

```
@atlas/core      — engine (provider, tool, hook, skill, agent, orchestrator)
atlas-os         — bin entry, REPL, command parsing, TUI
```

The split exists so `@atlas/core` can be embedded in non-CLI hosts (web UIs,
VS Code extensions, MCP servers) without dragging in TUI dependencies.

## Core concepts

### Agents (Greek gods)

- **Exactly one active at a time.**
- Selected by the **Orchestrator** based on detected project state.
- Define: role, persona, vocabulary, commands, **handoff triggers**.
- Stored: `~/.atlas/agents/<name>/AGENT.md` (YAML frontmatter + markdown body).
- The active agent's persona is injected into the system prompt.

### Skills

- **Many can be loaded** at once.
- Loaded **on-demand** by the active agent based on triggers in the user's
  request or the agent's context.
- Define: description, when_to_use, body (procedural knowledge).
- Stored: `~/.atlas/skills/<name>/SKILL.md`.
- Skills are listed in the system prompt with one-line descriptions; the
  agent calls `skill_view(name)` to load the full body.

### Hooks

Typed lifecycle events. Each hook is a function:

```ts
type Hook<E extends HookEvent> = (
  ctx: HookContext<E>
) => Promise<HookResult> | HookResult;

type HookResult =
  | { action: 'allow' }
  | { action: 'block', reason: string }
  | { action: 'modify', payload: unknown };
```

Events: `sessionStart`, `sessionEnd`, `beforeMessage`, `afterMessage`,
`beforeTool`, `afterTool`. Hooks can be configured per matcher (`beforeTool`
on `terminal` only, etc.).

### Tools

Typed by Zod schema for input. Output is a discriminated union (success /
error). Each tool has an approval mode: `auto`, `ask`, `never`. Tool
execution is fully cancellable via `AbortSignal`.

### Providers

OpenRouter is the default. Any model OpenRouter exposes can be selected at
runtime (`/model` slash command). Per-agent overrides are allowed: e.g.
Athena uses `anthropic/claude-sonnet-4`, Hercules uses `moonshotai/kimi-k2.6`.

### Orchestrator

Scans project state on session start and after each major operation:

```ts
interface ProjectState {
  hasGit: boolean;
  hasPRD: boolean;            // docs/prd.md
  hasArchitecture: boolean;   // docs/architecture.md
  hasStories: boolean;        // docs/stories/*.md
  activeStory: string | null;
  storyStatus: 'draft' | 'in-progress' | 'review' | 'done';
  hasUncommittedChanges: boolean;
  lastAgent: string | null;
}
```

A pure function maps state → recommended agent. Transitions are proposed,
not forced — the user can `/skip` or `/manual` at any handoff.

### Sessions

Every conversation persists to `~/.atlas/sessions/<iso-timestamp>.json` with
a complete decision audit log. `atlas resume` reopens the most recent.

### Context window manager

Tracks tokens consumed against the active model's context limit. At 80% it
auto-compacts older turns by summarizing them with a cheap model. Recent
turns and tool outputs are preserved verbatim.

## File layout (target)

```
packages/core/src/
├── index.ts                 — public barrel
├── result.ts                — Result<T, E>
├── errors.ts                — AtlasError + codes
├── logger.ts                — Pino logger
├── version.ts               — read from package.json
├── config/                  — ~/.atlas/config.yaml load/save
├── providers/               — OpenRouter / Anthropic / OpenAI / Ollama
├── tools/                   — read_file, write_file, terminal, search, …
├── hooks/                   — registry, runner, types
├── skills/                  — loader, parser, resolver
├── agents/                  — loader, parser, persona injection
├── orchestrator/            — project state detector, transition decisions
├── session/                 — manager, audit log, resume
├── context/                 — token counting, compaction
└── mcp/                     — MCP client (stdio + HTTP)

packages/cli/src/
├── index.ts                 — barrel for embedding hosts
├── app.ts                   — Commander program
├── bin/atlas.ts             — bin entry, top-level error boundary
├── repl/                    — Ink TUI components
├── commands/                — slash commands (/skill, /model, /agent, /skip, …)
└── format/                  — text formatting, syntax highlight, diff display
```

## SDD pipeline (post-1.0)

The post-1.0 track adds spec-driven-delivery primitives on top of the core
runtime. Each primitive is a small typed engine with a YAML-on-disk format
and built-in starter content.

### Templates (`packages/core/src/templates/`)

Handlebars-over-YAML document generator with first-class typed inputs.

- **Schema**: `id`, `version`, `title`, `owner` (agent), `editors`,
  `inputs` (typed: string/text/number/boolean/list/object), `output`
  (default path), `whenToUse`, `preamble` (verbatim byte-0 emission for
  formats like DESIGN.md), `sections[]`.
- **Section schema**: `id`, `title`, `instruction`, `elicit` (gate),
  `examples`, `condition` (truthy / `==` / `!=`), `repeatable`, `body`
  (Handlebars), `sections[]` (nested).
- **Helpers**: `eq`, `upper`, `lower`, `default`. Kept tiny on purpose.
- **Owner enforcement** (`TEMPLATE_OWNER_MISMATCH`) and **elicitation
  gate** (`TEMPLATE_INPUT_MISSING`) fail render rather than producing
  half-empty artifacts.
- **Loader**: `~/.atlas/templates/*.yaml`, deduplicated by id (newest
  version wins, lex-newer path on tie).
- **Starter set**: 16 templates including `product-brief`, `prd`,
  `architecture`, `epic`, `story`, `ux-spec`, `design-system`,
  `release-notes`, `adr`, `bug-report`, etc.

### Checklists (`packages/core/src/checklists/`)

Structural counterpart to templates: gate review, not creation.

- **Schema**: `id`, `version`, `title`, `owner`, `appliesTo`, `items[]`
  with per-item `severity` (`blocker` / `warning` / `info`) and `hint`.
- **Engine**: surfaces items to the agent, aggregates verdicts, computes
  `verdict: pass | fail` (pass iff no blocker fails). Does not
  auto-evaluate semantic items — the agent supplies pass/fail per item.
- **Starter set**: 17 checklists — 14 per-template (one per artifact) +
  3 cross-cutting (`security-review`, `definition-of-done`,
  `release-readiness`).
- **DESIGN.md adoption**: pegged to
  [google-labs-code/design.md](https://github.com/google-labs-code/design.md)
  v0.1.0; `npm` is a declared engine requirement so Aphrodite can shell
  out to `npx @google/design.md lint` deterministically.

### Workflows (`packages/core/src/workflows/`)

Declarative routing table — kept *outside* of agent code so it's
testable, inspectable, and overridable without rebuilding.

- **Chain step**: `(fromAgent, command?) → (toAgent, nextCommand?, reason?)`.
- **File**: `<cwd>/.atlas/workflows/chains.yaml` (project) overrides
  `~/.atlas/workflows/chains.yaml` (user) overrides built-ins.
- **Resolution priority** in `recommendNext`:
  1. **Handoff queue** — oldest unconsumed handoff wins. Handoff files
     are gray-matter frontmatter envelopes left by upstream agents.
  2. **Chain table** — when `fromAgent` is supplied; specific command
     match beats wildcard.
  3. **Static state fallback** — `recommendAgent(state)` based on
     detected artifacts.
- **Discriminator**: `source: 'handoff' | 'chain' | 'state'` so the TUI
  can explain *why* the next agent was picked.

### Stories (`packages/core/src/stories/`)

Mixed-mode authorization for a single shared artifact (the story file).
Each agent declares `authorizedSections` / `forbiddenSections`; the
`story_update` tool enforces them at the boundary so Hercules can write
"Implementation Notes" but never "Acceptance Criteria".

### Project state (`packages/core/src/orchestrator/`)

Pure side-effecting reads (no decisions). Detects `hasGit`, `hasPRD`,
`hasArchitecture`, `hasStories`, `storyCount`,
`hasUncommittedChanges`. The `decide.ts` module is a pure function
mapping state → recommended agent; the split keeps both unit-testable.

## Comparison: Atlas vs BMAD-METHOD

Atlas overlaps with [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD)
in scope (multi-agent SDD pipeline) but diverges deliberately:

| Capability | Atlas | BMAD |
| ---------- | ----- | ---- |
| Stack | TS strict + Zod boundaries | JS + Python + uv |
| Agent format | TS object literal (kind: framework/user) | Markdown + TOML + JSON manifest |
| Workflow definition | Declarative `chains.yaml` table | XML-in-markdown step machine inside each SKILL.md |
| Checklist engine | Typed runner with per-item severity + verdict | Inert markdown read by LLM |
| Spec adherence | DESIGN.md byte-spec test (`@google/design.md`) | None equivalent |
| Templates | Handlebars-over-YAML, single render | Section-bound `<template-output>` directives, streaming |
| Customization | Built-in → user (`~/.atlas`) → project (`<cwd>/.atlas`) overlays | base → team → user TOML deep-merge |
| Status file | Handoff queue + `.atlas/state.yaml` story/artifact status | `sprint-status.yaml` shared mutable state |

Phases 8–11 now cover sectioned templates, project state, workflow
gates/activation metadata, and overlay customization without adopting
BMAD's XML-in-markdown DSL or its multi-runtime requirement.

## Invariants

These are the rules the codebase must always satisfy. If you find code
that breaks one of these, the code is wrong — not the rule. New
invariants get appended here in the same commit that introduces them.

1. **No `any`.** All boundaries narrow to typed values via Zod or
   explicit `unknown` + guards. Strict TypeScript settings
   (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
   `exactOptionalPropertyTypes`) are non-negotiable.
2. **Cancellation everywhere.** Every async path that can take more
   than ~100 ms accepts and propagates an `AbortSignal`. Provider
   streams, tool `execute`, hooks, MCP calls, terminal child
   processes — all share one `AbortController` per turn.
3. **Tool `summary` is the only field that reaches the model.** Bulk
   content (file text, HTTP body, stdout/stderr) goes in `data.*`.
   Summaries are head+tail truncated via
   [truncate.ts](packages/core/src/tools/truncate.ts); the agent loop
   enforces a 32 KB hard backstop on top.
4. **Prompt-cache markers go on the *last* static block.** Anthropic
   `cache_control: { type: 'ephemeral' }` is set on the system prompt
   and on the last static tool spec — never on per-turn dynamic
   content. Marking dynamic content invalidates the prefix and burns
   tokens.
5. **Token usage merges via `mergeUsage`, never spread-overwrite.**
   Partial usage payloads (notably Anthropic `message_delta`) carry
   only the fields they update. A naive `{ ...prev, ...next }` resets
   `promptTokens` to zero whenever a delta omits it.
6. **ESM only.** `"type": "module"` everywhere. Import specifiers use
   the `.js` suffix even when the source is `.ts` —
   `verbatimModuleSyntax` will not rewrite them.
7. **Skill files start with YAML frontmatter.** Any agent or tool that
   mutates a `SKILL.md` must preserve frontmatter order and the
   trailing blank line; the loader reads frontmatter first and the
   body second.
8. **Result over throw for control flow.** `Result<T, AtlasError>`
   from `@atlas/core` is the only acceptable error channel for
   recoverable failures. Throwing is reserved for impossible-state
   programmer errors.
9. **Customization is layered, never replaced.** Built-in →
   `~/.atlas/` (user) → `<cwd>/.atlas/` (project) deep-merge. Loaders
   must apply all three layers; never short-circuit because user or
   project is empty.

## Phase plan

See README.md. Each phase ships a working CLI; phases are not allowed to
overlap — current phase finishes (typecheck + tests + lint clean) before
the next begins.
