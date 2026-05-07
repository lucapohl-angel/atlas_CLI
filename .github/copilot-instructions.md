# Copilot instructions — atlas-cli

## TL;DR

Read [AGENTS.md](AGENTS.md) for the full project rules. The notes below
are repository-specific overrides that change Copilot's defaults.

## OpenTUI work — always load the skill first

The repository ships one full-screen TUI:

- **OpenTUI** (default, Bun/native binary) — maintained in
  [packages/cli/src/tui/opentui/](packages/cli/src/tui/opentui/).

The legacy Ink TUI was retired; do not reintroduce Ink dependencies,
`--ui=ink` fallbacks, or parity instructions that point at
`packages/cli/src/tui/App.tsx`.

When making **any** change inside `packages/cli/src/tui/opentui/`,
**before** writing code:

1. Load the **`opentui` skill** at
   `~/.agents/skills/opentui/SKILL.md` — it routes you to the canonical
   docs (renderer, layout, keymap, React bindings, components).
2. Skim the doc for the component/hook you're about to use. The most
   common gotchas are:
   - `<text>` only accepts **plain strings** as children. **Never**
     nest `<text>` inside `<text>`. Use sibling `<text>` nodes inside
     a `flexDirection: 'row'` `<box>` if you need inline color
     changes.
   - The renderer's clear color defaults to **transparent**. Always
     pass `backgroundColor` to `createCliRenderer` AND set
     `backgroundColor` on the outermost layout `<box>` AND on
     `<scrollbox>` `viewportOptions`/`contentOptions` — otherwise
     cells the React tree doesn't claim read as the user's terminal
     default and look "transparent."
   - There is no `useAlternateScreen` option. Use
     `screenMode: 'alternate-screen' | 'main-screen' | 'split-footer'`.
   - Bold/italic/underline are not `attributes` numeric flags — they
     are `style` booleans on `StyleAttrs`, or template-literal helpers
     (`bold`, `italic`, …) from `@opentui/core/lib/styled-text`.
   - Keyboard input goes through `useKeyboard((key) => …)`. `key.name`
     for special keys, `key.sequence` for printable chars (length 1,
     code ≥ 0x20), `key.ctrl` / `key.meta` for modifiers.

If you skip the skill and guess at the API, you will hit runtime
errors like `TextNodeRenderable only accepts strings, …` or silent
"transparent middle" rendering bugs.

## Don't publish

The release workflow is gated behind a manual `workflow_dispatch` with
`publish=true`. Do **not** push tags expecting an auto-publish; tag
pushes only build artifacts. The user will trigger publishing
explicitly when the build is ready.

## OpenTUI Is The Runtime

OpenTUI is the default and only maintained full-screen UI. Visuals
(popups, borders, palette) can evolve, but **state machine, gating
rules, and data sources must follow the workflow contract exactly**.

**Single source of truth for the user workflow:**
[context/tui-workflow.md](../context/tui-workflow.md). Read it
before adding or changing any TUI screen. It documents the
canonical command list, popup sizing, color invariants
(green=connected, accent=headers, warning=popular, success=selected),
the MCP catalog (filesystem, github, higgsfield, figma + memory),
and the slash autocomplete contract. When you change a workflow
rule, update this document and `context/tui-workflow.md` in the same
change. Established invariants:

- **Switchable agents**: only the orchestrator (`atlas`) plus
  user-installed (non-framework) agents. Filter via `isFrameworkAgent`
  from `@atlas/core`. Framework specialists (Athena/Prometheus/
  Hercules/…) are routed to **by** `atlas`, never picked manually.
  Tab opens the agent picker **only when `switchableAgents.length >
  1`** — otherwise no-op (or surface "install custom agents under
  `~/.atlas/agents/`").
- **Model picker**: source from the live `modelCatalog: ModelInfo[]`
  prop (passed by `runTui.ts`), not a hardcoded list. Always include
  the active model, the configured default, declared fallbacks, and
  provider custom model lists (`config.providers.openrouter.customModels`,
  `config.providers.opencode.zen.customModels`, and
  `config.providers.opencode.go.customModels`). Static seed list is a
  fallback only.
- **Thinking levels**: filter per-model via
  `thinkingLevelsFor(activeModel, modelCatalog)`. Reject unsupported
  levels in `/thinking <level>` with the allowed set.
- **Provider tag / context window**: resolve through the catalog
  first (`providerKindFor` / `contextWindowFor` patterns), id-shape
  heuristics only as fallback. This matters for multi-key users where
  `gpt-5` could be OpenRouter or Codex OAuth.
- **Slash commands**: keep the OpenTUI command set in sync with
  `context/tui-workflow.md`. Stub unimplemented commands with a clear
  "not yet implemented" message rather than failing silently.
- **Props bag**: `OpenTuiAppProps` accepts whatever `runTui.ts`
  passes (modelCatalog, providers, availableModels, mcpStatus,
  initialSession, autoResumed, initialActiveTask, …). Don't drop or
  rename fields — extend the interface instead.

## Preserve the Atlas brand

The OpenTUI variant uses an **Atlas-blue navy** palette (see
[packages/cli/src/tui/opentui/palette.ts](packages/cli/src/tui/opentui/palette.ts)).
Don't introduce new accent colors without updating the palette
constants.
