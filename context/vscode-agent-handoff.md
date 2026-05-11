# VS Code Extension Agent Handoff

Date: 2026-05-08

This handoff is for the next agent continuing the Atlas VS Code extension.
The user wants the Atlas core workflow translated into a VS Code-native UI,
with function first and visual polish later. Keep the implementation grounded
in `@atlas/core`; the extension is a second host, not a fork of the engine.

## Read first

1. [../AGENTS.md](../AGENTS.md)
2. [project-overview.md](project-overview.md)
3. [../ARCHITECTURE.md](../ARCHITECTURE.md)
4. [code-standards.md](code-standards.md)
5. [ai-workflow-rules.md](ai-workflow-rules.md)
6. [tui-workflow.md](tui-workflow.md)
7. [vscode-extension-plan.md](vscode-extension-plan.md)
8. [progress-tracker.md](progress-tracker.md)

If you edit `packages/cli/src/tui/opentui/`, load the OpenTUI skill first.
For VS Code work, use the OpenTUI code and `tui-workflow.md` as behavioral
references, but do not reintroduce Ink or fork workflow state.

## Current state

Package: `packages/vscode` (`atlas-os-vscode@0.1.0`)

The extension already has:

- VS Code secondary side-bar webview container `atlas.sidebar`.
- Zod-validated webview bridge in [../packages/vscode/src/bridge.ts](../packages/vscode/src/bridge.ts).
- Headless Atlas session host in [../packages/vscode/src/session-host.ts](../packages/vscode/src/session-host.ts).
- VS Code-native tools for read/write/edit/terminal under [../packages/vscode/src/tools/](../packages/vscode/src/tools/).
- Atlas-branded React webview in [../packages/vscode/src/ui/main.tsx](../packages/vscode/src/ui/main.tsx) and [../packages/vscode/src/ui/styles.css](../packages/vscode/src/ui/styles.css).
- Sanitized settings summary and config opening from the extension host.
- Slash autocomplete and a command map for the canonical Atlas slash commands.
- Clickable workspace file references in assistant text and tool rows.
- Native editor opening through the extension host, never through `file://` URLs
  in the webview.
- Live sanitized model catalog rows, model selection, model-aware thinking
  validation, and provider recreation for subsequent turns.
- Installed-agent picker for `atlas` plus user non-framework agents.
- MCP manager actions, sessions/resume/rename/delete, active workflow status,
  session todos, inline approvals, SecretStorage-backed keys, safe settings
  controls, Codex sign-in, VSIX packaging, and turn cancellation surfaces.

The current dirty working tree from this slice was:

- [../packages/vscode/src/bridge.ts](../packages/vscode/src/bridge.ts)
- [../packages/vscode/src/bridge.test.ts](../packages/vscode/src/bridge.test.ts)
- [../packages/vscode/src/extension.ts](../packages/vscode/src/extension.ts)
- [../packages/vscode/src/approval-broker.ts](../packages/vscode/src/approval-broker.ts)
- [../packages/vscode/src/config-store.ts](../packages/vscode/src/config-store.ts)
- [../packages/vscode/src/model-catalog.ts](../packages/vscode/src/model-catalog.ts)
- [../packages/vscode/src/session-host.ts](../packages/vscode/src/session-host.ts)
- [../packages/vscode/src/ui/main.tsx](../packages/vscode/src/ui/main.tsx)
- [../packages/vscode/src/ui/styles.css](../packages/vscode/src/ui/styles.css)
- [../packages/vscode/package.json](../packages/vscode/package.json)
- [../packages/vscode/LICENSE](../packages/vscode/LICENSE)
- [../packages/vscode/README.md](../packages/vscode/README.md)
- [../.github/workflows/vscode-extension.yml](../.github/workflows/vscode-extension.yml)
- [../README.md](../README.md)
- [../pnpm-lock.yaml](../pnpm-lock.yaml)
- [vscode-extension-plan.md](vscode-extension-plan.md)
- [progress-tracker.md](progress-tracker.md)
- this handoff file

Do not revert unrelated user changes. If you see extra dirty files, inspect
before touching them.

## Last completed slice

Implemented the remaining VS Code Phase 2.C-2.E slice:

- Added a live VS Code model catalog adapter in
  [../packages/vscode/src/model-catalog.ts](../packages/vscode/src/model-catalog.ts)
  that queries Atlas provider catalogs, includes active/default/fallback/custom
  rows, sanitizes metadata, and keeps secrets out of webview payloads.
- Wired `/model` and the bottom model selector to live model rows; selection
  validates supported thinking levels, persists safe config defaults where the
  provider maps to `AtlasConfig.defaultProvider`, and recreates the runtime host.
- Wired `/agent`, the bottom agent selector, and Tab to installed agents using
  the canonical switchability rule: `atlas` plus user non-framework agents.
- Added bridge/runtime/UI surfaces for MCP status, saved sessions, resume/new/
  delete session actions, active workflow task state, and per-session todos from
  the core `todo` tool.
- Added `AbortController` cancellation from the webview stop button and Escape
  shortcut through the VS Code host into `runAgentLoop`.
- Added inline approval cards with modal approval as fallback.
- Added VS Code SecretStorage-backed provider key prompts, safe settings
  controls, and ChatGPT / Codex browser sign-in.
- Added safe MCP add/enable/disable/remove actions and native session rename.
- Added VSIX packaging script and CI artifact workflow with manually gated
  marketplace publish.
- Extended tool streaming so completed tool calls update in the transcript and
  can refresh the visible todo list.
- Updated [vscode-extension-plan.md](vscode-extension-plan.md) and
  [progress-tracker.md](progress-tracker.md).

Validation already run after the slice:

```sh
bunx pnpm@10.33.2 --filter atlas-os-vscode test:run
bunx pnpm@10.33.2 --filter atlas-os-vscode build
bunx pnpm@10.33.2 --filter atlas-os-vscode run package
bunx pnpm@10.33.2 typecheck
bunx pnpm@10.33.2 test:run
bunx pnpm@10.33.2 lint
```

Re-run the full gate before declaring further code changes complete. Build and
package still emit the known esbuild warning about `import.meta` when bundling
`@atlas/core/dist/version.js` into the CJS extension host bundle.

## Next work, recommended order

### 1. Manual VS Code smoke

Goal: install the generated VSIX in a real VS Code window and exercise one turn.

Acceptance criteria:

- Sidebar loads from the packaged VSIX.
- Inline approval cards approve/deny an ask-mode tool.
- Model, agent, MCP, session, settings, and task screens open without console
  errors.

### 2. Phase 2.F editor integrations

Goal: add optional editor entry points on top of the sidebar.

Acceptance criteria:

- Commands can send selected code or the current diff into Atlas.
- Quick-fix/code-lens actions are scoped and do not replace the sidebar flow.

## Important guardrails

- Keep the bridge typed with Zod on both request and response surfaces.
- The webview must not receive raw Node objects, raw VS Code APIs, or secrets.
- Use VS Code-native APIs for file opening, edits, terminal, secrets, and auth.
- Prefer structured data from `@atlas/core`; do not parse config with ad hoc
  strings when schemas/loaders exist.
- Do not hardcode model or agent lists except as explicit fallback placeholders.
- If a slash command is visible but not implemented yet, show a clear
  "not yet ported" message instead of silently doing nothing.
- Keep visuals in the Atlas navy/bright-blue brand, but prioritize functional
  mapping now. The user plans to refine UI later.

## Useful commands

Run targeted VS Code checks:

```sh
bunx pnpm@10.33.2 --filter atlas-os-vscode test:run
set -o pipefail && bunx pnpm@10.33.2 --filter atlas-os-vscode build 2>&1 | tail -n 100
```

Broader repo gate from AGENTS.md when finishing substantial code:

```sh
pnpm typecheck && pnpm test:run && pnpm lint
```

Package-level scripts from [../packages/vscode/package.json](../packages/vscode/package.json):

```sh
pnpm --filter atlas-os-vscode dev
pnpm --filter atlas-os-vscode test:run
pnpm --filter atlas-os-vscode build
pnpm --filter atlas-os-vscode run package
```

## Suggested next agent prompt

Continue the Atlas VS Code extension from [vscode-agent-handoff.md](vscode-agent-handoff.md).
Install the generated VSIX for a manual VS Code smoke, then implement the next
Phase 2.F editor-integration slice. Read the required context files first, keep
the bridge typed and sanitized, use `@atlas/core` as source of truth, update
tests/docs, and run the targeted VS Code extension test/build/package commands
before finalizing.
