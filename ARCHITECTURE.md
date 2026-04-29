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
   hundreds of models. Anthropic / OpenAI / Google / Ollama are first-class.
4. **Skill-extensible**: Hermes-style on-demand skills loaded by the active
   agent when triggered by context.
5. **Beginner-friendly**: project state detection drives automatic agent
   selection, with clear visual indication of who is active and why.

## Packages

```
@atlas/core      — engine (provider, tool, hook, skill, agent, orchestrator)
atlas-cli        — bin entry, REPL, command parsing, TUI
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

### Skills (Hermes-style)

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

## Phase plan

See README.md. Each phase ships a working CLI; phases are not allowed to
overlap — current phase finishes (typecheck + tests + lint clean) before
the next begins.
