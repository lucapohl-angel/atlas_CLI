# VS Code Extension — Future Improvement Plan

> Status: **in progress**. Phase 2.A is complete and Phase 2.B has a
> working smoke path: package metadata, side-bar webview shell,
> Zod-validated bridge, local session host, and `Atlas: Run Turn`.
> VS Code-native tools and the full webview workflow are not built yet.

## Goal

Ship Atlas as a VS Code extension with a native side-bar UI, so users
can run the same agent crew, tools, hooks, skills, and SDD pipeline
without leaving the editor. The extension is a **second host** for
`@atlas/core` — not a fork of the engine.

## Why a separate package (not an Ink/OpenTUI re-skin)

The split between `@atlas/core` (engine) and `atlas-os` (TUI host)
already exists for this reason — see ARCHITECTURE.md "Packages":

> The split exists so `@atlas/core` can be embedded in non-CLI hosts
> (web UIs, VS Code extensions, MCP servers) without dragging in TUI
> dependencies.

The extension is the third host. It depends on `@atlas/core`
directly and never pulls `atlas-os` in.

## Why a webview (not the native VS Code Chat API)

`vscode.chat` (Copilot-style) locks the UX into a single-turn,
single-agent paradigm and fights with our orchestrator + multi-agent
handoff model. A webview view contributed to the side bar gives us:

- Full control over the screens we already designed for the TUI
  (agent picker, model picker, slash autocomplete, MCP status, todo
  tracker, sessions/resume).
- The same Atlas-blue palette and brand.
- Freedom to add SDD-pipeline surfaces (story status, checklist
  verdicts, workflow chain visualization) without bending native
  chat APIs.

## Package layout

Add a third package alongside `core` and `cli`:

```
packages/
  core/         (unchanged — engine)
  cli/          (unchanged — TUI host)
  vscode/       NEW — VS Code extension host
    package.json         contributes: view, commands, settings, secrets
    tsconfig.json
    vitest.config.ts
    src/
      extension.ts       activate() / deactivate()
      bridge.ts          typed message protocol (webview ↔ extension host)
      session-host.ts    one Atlas session per workspace
      providers.ts       wraps providerFromConfig + VS Code SecretStorage
      tools/
        vscode-fs.ts        read/write/edit through vscode.workspace.fs
        vscode-terminal.ts  Pseudoterminal-backed terminal tool
        vscode-edit.ts      WorkspaceEdit-backed edit_file
      ui/                  React + Vite app, bundled to dist/webview/
        main.tsx
        screens/
        components/
        bridge-client.ts
    scripts/
      bundle.mjs         esbuild for extension.ts; vite for ui/
```

## Distribution

- Built with `vsce package` → `.vsix`.
- Published to the VS Code Marketplace under the same
  `lucapohl-angel` org.
- Runs in the VS Code extension host (Node), so no Bun cross-compile
  is needed for this package — unlike `atlas-os`, which ships
  per-platform Bun-compiled binaries.
- Extension bundles `@atlas/core` directly via esbuild.

## Hard rules (mirror OpenTUI rules from `.github/copilot-instructions.md`)

- **Re-skin only.** State machine, gating rules, and data sources
  must mirror the canonical TUI workflow in
  [`tui-workflow.md`](tui-workflow.md). Visuals can differ.
- **No engine forking.** Anything you'd be tempted to add in the
  extension belongs in `@atlas/core`.
- **Cancellation everywhere.** Every webview action threads a
  `vscode.CancellationToken` → `AbortController` → engine `signal`.
- **Switchable agents** — same rule as OpenTUI: orchestrator (`atlas`)
  plus user-installed non-framework agents only. Filter via
  `isFrameworkAgent` from `@atlas/core`.
- **Model picker** sources from the live `ModelInfo[]` catalog, not
  a hardcoded list.
- **Slash commands** stay in sync with `context/tui-workflow.md`.
  Stub anything unimplemented with a clear "not yet ported in VS
  Code variant" message.

## Phased implementation

### Phase 2.A — Skeleton + bridge

Foundational; the side-bar shell is visible and talks to the extension host
through the bridge.

- [x] Bootstrap `packages/vscode` with `engines.vscode`, esbuild for the
  extension entry, Vite for the webview.
- [x] Define `bridge.ts` as a Zod-validated message union:
  `{requestId, kind, params}` →
  `{response | stream-event | error}`. Same shape as the provider
  `StreamEvent` so the UI can render incrementally.
- [x] Wire `webview.postMessage` ↔ `panel.onDidReceiveMessage` with a
  small request/response correlator. Never expose Node primitives or
  raw `vscode` APIs to the webview — the bridge is the only surface.

### Phase 2.B — Headless engine adapter

- [x] `session-host.ts` builds a local in-memory Atlas session from
  `@atlas/core` with provider, agents, skills, tools, hooks, and prompt
  composition, but with no terminal I/O.
- VS Code-native tool implementations:
  - [ ] `read_file` / `write_file` → `vscode.workspace.fs` (respects
    unsaved editor state via `openTextDocument`).
  - [ ] `edit_file` → `vscode.WorkspaceEdit` so edits land as native
    diffs with full undo.
  - [ ] `terminal` → `vscode.window.createTerminal` backed by a
    `Pseudoterminal` so output streams into the engine.
- [ ] Approval prompts route to `vscode.window.showInformationMessage`
  (modal) for now; later, surface inline in the webview.
- [x] Smoke goal: a Command Palette command (`Atlas: Run Turn`) that
  takes a string, runs one engine turn, prints to an Output channel.
  Nothing pretty — just proves the engine works in the host.

### Phase 2.C — Webview UI

- React + Vite inside `src/ui/`. Reuse the Atlas-blue palette
  tokens from `packages/cli/src/tui/opentui/palette.ts` (or extract
  to a shared `@atlas/brand` later).
- Screens to ship (mirror `tui-workflow.md`):
  1. Conversation pane (streaming deltas, tool calls, tool results,
     thinking blocks).
  2. Slash autocomplete.
  3. Agent picker (Tab).
  4. Model picker (`/model`).
  5. MCP status.
  6. Todo / task list.
  7. Sessions / resume.
- Storage: session pointers in `vscode.ExtensionContext.globalState`;
  the session JSON files themselves stay in `~/.atlas/sessions/` so
  the CLI and extension share state seamlessly.

### Phase 2.D — Config, auth, settings

- Read `~/.atlas/config.yaml` first; layer VS Code Settings
  (`atlas.*`) on top via merge. Settings UI gives non-CLI users a
  way in.
- API keys via `vscode.SecretStorage` — never in Settings JSON.
- OAuth flows (Claude Code, Codex) via `vscode.env.openExternal` +
  a registered `vscode://lucapohl-angel.atlas/auth/callback` URI
  handler.
- Honor `~/.atlas/agents/`, `~/.atlas/skills/`, `~/.atlas/templates/`
  the same way the CLI does — same loaders, same precedence.

### Phase 2.E — Distribution & release

- `vsce package` in CI on tag push (separate workflow from the
  binaries release).
- Marketplace publish gated by the same manual `workflow_dispatch`
  pattern as the npm release (do not auto-publish on tag).
- Document install steps in a new top-level README section.

## Open questions

- **Inline editor actions**: should we add code-lens / quick-fix
  entry points (e.g. "Atlas: implement this story", "Atlas: review
  diff") on top of the side-bar UI? Probably yes in a phase 2.F.
- **Multi-root workspaces**: one session per workspace folder, or
  one session per VS Code window? Lean toward per-folder so each
  project has its own audit log.
- **Remote / Codespaces**: extension runs in the remote extension
  host, but `~/.atlas/` lives where? Likely the remote machine —
  document this clearly.
- **Sharing models with the CLI**: if the user has Atlas open in a
  terminal and in VS Code, both will load `~/.atlas/config.yaml`.
  Fine for read; for writes (e.g. `/model` switching) we need a
  small file lock or last-writer-wins with a reload notice.

## Non-goals (for the first release)

- Replacing GitHub Copilot. Atlas in VS Code is a separate surface
  with a different model: agentic, multi-step, hook-gated.
- Inline ghost-text completions. Out of scope; that's a different
  UX problem and a different latency budget.
- Replacing the TUI. Both hosts ship; users pick.
