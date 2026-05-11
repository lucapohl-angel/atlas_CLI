# AGENTS.md

> Guidance for AI agents (Codex CLI, Claude Code, Atlas itself, anything else)
> working on this repository. The reader of this file is assumed to know nothing
> about the project.

## What this project is

Atlas·OS is a multi-agent, hook-driven, model-agnostic engineering CLI for the
terminal. A "crew" of specialist agents (Greek gods — Athena, Prometheus,
Hercules, Nemesis, Iris, etc.) handle different phases of the software lifecycle:
planning, architecture, story splitting, implementation, QA, and release.

- **Multi-agent**: exactly one agent is active at a time; the Orchestrator picks
  based on detected project state.
- **Hook-driven**: typed lifecycle events (`beforeTool`, `afterTool`, etc.) with
  real blocking semantics so guardrails are enforced, not suggested.
- **Model-agnostic**: OpenRouter is the default. Anthropic, OpenAI, OpenCode
  Zen/Go, and local models (Ollama, LM Studio, vLLM, llama.cpp) are also
  supported.
- **Skill-extensible**: on-demand skills loaded by the active agent when
  triggered by context.
- **Spec-driven delivery (SDD)**: built-in templates, checklists, workflows, and
  stories that drive a repeatable planning-to-ship pipeline.

The project is an MIT-licensed npm package (`atlas-os`) with an optional native
binary per platform, plus a VS Code extension (`atlas-os-vscode`).

---

## Read these first (in order)

1. [`context/project-overview.md`](context/project-overview.md) — what Atlas is,
   the user flow, in/out of scope, success criteria.
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — engine layout, SDD pipeline,
   core concepts (agents, skills, hooks, tools, providers, orchestrator,
   sessions, context window manager), and the **Invariants** section (rules the
   codebase must always satisfy).
3. [`context/code-standards.md`](context/code-standards.md) — strict TS, ESM,
   Result, Zod, tool contract, testing conventions.
4. [`context/ai-workflow-rules.md`](context/ai-workflow-rules.md) — scoping,
   splitting, protected files, verification gates, doc-update rules.
5. [`context/progress-tracker.md`](context/progress-tracker.md) — current phase,
   in-progress work, open questions, recent decisions.
6. [`README.md`](README.md) — quickstart and phase tables.

If you only have time for two files, read 1 and 5.

---

## Technology stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ (ESM) |
| Language | TypeScript 5.8+ in **strict mode** |
| Package manager | pnpm 10.33.2 (monorepo workspace) |
| Module system | ESM only (`"type": "module"`) |
| UI framework | React 19 + OpenTUI (`@opentui/core` / `@opentui/react`) |
| CLI framework | Commander.js |
| Validation | Zod (every I/O boundary) |
| Testing | Vitest |
| Logging | Pino (stderr) |
| Bundling | esbuild (CLI + VS Code extension), Vite (VS Code webview) |
| Native binaries | Bun `build --compile` (cross-compiled from Linux) |
| Config format | YAML (`~/.atlas/config.yaml`) |

---

## Project structure

```
atlas-cli/
├── packages/
│   ├── core/        @atlas/core — engine (providers, tools, hooks, skills,
│   │                agents, orchestrator, session, context, MCP, templates,
│   │                checklists, workflows, stories, builtins, protocol, loop)
│   ├── cli/         atlas-os — bin entry, REPL, command parsing, TUI,
│   │                slash commands, transcript, update notice, launcher
│   ├── vscode/      atlas-os-vscode — VS Code extension host, side-bar webview,
│   │                bridge, session host, VS Code-native tool adapters
│   └── binaries/    per-platform npm packages that ship a Bun-compiled
│                    `atlas` executable. Built by scripts/build-binaries.mjs.
│                    Published as optionalDependencies of atlas-os.
├── scripts/
│   ├── build-binaries.mjs   bun build --compile per target (linux-x64,
│   │                        linux-arm64, darwin-x64, darwin-arm64, win32-x64)
│   ├── lint.mjs             repo text hygiene (trailing whitespace, merge
│   │                        conflict markers) + per-package tsc --noEmit
│   └── require-pnpm.mjs     preinstall guard enforcing pnpm
├── .github/workflows/
│   ├── ci.yml               push/PR gate: build, typecheck, test:run, lint
│   ├── release.yml          tag-triggered cross-compile + opt-in npm publish
│   └── vscode-extension.yml tag-triggered VSIX build + opt-in Marketplace publish
├── context/                 project-level context docs (this is dogfooding)
├── tsconfig.base.json       shared strict TS config (incl. noUncheckedIndexedAccess,
│                            verbatimModuleSyntax)
└── pnpm-workspace.yaml      packages/* + packages/binaries/*
```

### Package split rationale

`@atlas/core` is the headless engine. It can be embedded in non-CLI hosts
(web UIs, VS Code extensions, MCP servers) without dragging in TUI dependencies.
`atlas-os` is the terminal-facing CLI. `atlas-os-vscode` is the VS Code
extension host.

### Source file layout (key modules)

```
packages/core/src/
├── index.ts          public barrel (stable API surface)
├── result.ts         Result<T, E> — explicit success/failure
├── errors.ts         AtlasError + stable error codes
├── logger.ts         Pino logger
├── version.ts        read from package.json (injected at bundle time)
├── config/           ~/.atlas/config.yaml load/save
├── providers/        OpenRouter / Anthropic / OpenAI / Codex / local / OpenCode
├── tools/            read_file, write_file, edit_file, terminal, search, …
├── hooks/            registry, runner, types, built-in guardrails
├── skills/           loader, parser, resolver
├── agents/           loader, parser, persona injection
├── orchestrator/     project state detector, transition decisions
├── session/          manager, audit log, resume
├── context/          token counting, compaction
├── mcp/              MCP client (stdio + HTTP)
├── templates/        Handlebars-over-YAML document generator
├── checklists/       gate review engine
├── workflows/        declarative routing table (chains.yaml)
├── stories/          mixed-mode authorization for story files
├── workflow/         executor, router, phase prompts, signals, waves
├── builtins/         built-in agents, templates, checklists, workflows
├── protocol/         interaction format
└── security/         URL safety

packages/cli/src/
├── index.ts          barrel for embedding hosts
├── app.ts            Commander program
├── bin/atlas.ts      bin entry, top-level error boundary
├── repl/             REPL logic
├── commands/         slash commands and subcommands (ask, init, status, vscode-setup, …)
└── tui/              OpenTUI components, transcript, update notice, learn, exit splash

packages/vscode/src/
├── extension.ts      activation entry
├── bridge.ts         webview <-> extension host message bridge
├── session-host.ts   local Atlas core turn runner
├── config-store.ts   VS Code settings + SecretStorage adapter
├── model-catalog.ts  model picker data
├── approval-broker.ts modal approval UI
├── tools/            VS Code-native tool adapters (fs, edit, terminal, approval)
└── ui/               webview React app (built by Vite)
```

---

## Build and test commands

### Full quality gate (run this before declaring any task done)

```bash
pnpm --filter @atlas/core build
pnpm --filter @atlas/core test:run
pnpm --filter atlas-os typecheck
pnpm --filter atlas-os test:run
pnpm --filter atlas-os build
pnpm --filter atlas-os-vscode typecheck
pnpm --filter atlas-os-vscode test:run
pnpm --filter atlas-os-vscode build
pnpm lint
```

### Per-package commands

| Package | Build | Test (watch) | Test (CI) | Typecheck | Lint |
|---|---|---|---|---|---|
| `@atlas/core` | `pnpm --filter @atlas/core build` | `pnpm --filter @atlas/core test` | `pnpm --filter @atlas/core test:run` | `pnpm --filter @atlas/core typecheck` | `pnpm --filter @atlas/core lint` |
| `atlas-os` | `pnpm --filter atlas-os build` | `pnpm --filter atlas-os test` | `pnpm --filter atlas-os test:run` | `pnpm --filter atlas-os typecheck` | `pnpm --filter atlas-os lint` |
| `atlas-os-vscode` | `pnpm --filter atlas-os-vscode build` | `pnpm --filter atlas-os-vscode test` | `pnpm --filter atlas-os-vscode test:run` | `pnpm --filter atlas-os-vscode typecheck` | `pnpm --filter atlas-os-vscode lint` |
| Workspace root | `pnpm build` | — | `pnpm test:run` | `pnpm typecheck` | `pnpm lint` |

### What the commands do

- `build` (`@atlas/core`): `tsc -p tsconfig.build.json` — declaration emit + JS.
- `build` (`atlas-os`): builds `@atlas/core` first, then `tsc --noEmit` + esbuild
  bundle (`scripts/bundle.mjs`) producing `dist/launcher.mjs`, `dist/bin/atlas.js`,
  and `dist/index.js`.
- `build` (`atlas-os-vscode`): builds `@atlas/core` first, then esbuild for the
  extension host + Vite for the webview.
- `test` / `test:run`: Vitest. Tests must run without network access.
- `typecheck` / `lint`: `tsc --noEmit`.
- `pnpm lint` (root): runs `scripts/lint.mjs` which checks all tracked text files
  for trailing whitespace and unresolved merge-conflict markers, then runs each
  package's `lint` script.

---

## Code style guidelines

These are enforced, not aspirational.

### TypeScript

- **Strict mode is mandatory.** `strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `exactOptionalPropertyTypes` are non-negotiable.
- **No `any`.** Use `unknown` and narrow with Zod or `typeof`/`in` guards. If
  you genuinely need `any`, leave a one-line comment naming the bug-or-third-party
  reason.
- **No exceptions for control flow.** Return `Result<T, AtlasError>` from
  `@atlas/core/result`. Throw only for programmer errors (impossible-state
  assertions). External calls that throw are caught and converted at the boundary.
- **Validate at I/O boundaries.** Provider responses, tool inputs, config files,
  MCP messages — every byte that crosses a process boundary goes through Zod
  before business code touches it.
- **`readonly` and immutable updates** by default. Mutate only inside the
  function that owns the value.
- **`as const`** for literal types and discriminated unions. Prefer discriminated
  unions over enums.

### ESM

- `"type": "module"` everywhere.
- Import specifiers use the `.js` suffix even when the source is `.ts`:
  `import { foo } from './bar.js'`. `verbatimModuleSyntax` will not rewrite them.
- `import type { … }` for type-only imports.
- Named exports only. No default exports.

### File layout + naming

- File names: `kebab-case.ts`.
- Test files sit beside source: `foo.ts` → `foo.test.ts`. No `__tests__/` folders.
- Type names: `PascalCase`.
- Functions / variables / constants: `camelCase`.
- Module-level constants that are genuinely constant: `SCREAMING_SNAKE` (rare).
- One public concept per file. Helpers with no callers outside the module stay
  un-exported.

### Async + cancellation

- **Every async path that can take more than ~100 ms accepts an `AbortSignal`**
  and propagates it down. Provider streams, tool `execute`, hooks, MCP calls,
  terminal child processes — all share one `AbortController` per turn.
- Check `signal.aborted` at the top of long loops and after every awaited boundary.

### Errors + logging

- Use `atlasError(code, message, { cause, context })`. New codes go in
  `packages/core/src/errors.ts` with a doc comment.
- `Result.err(atlasError(...))` over throwing. Callers pattern-match.
- Pino via `@atlas/core/logger` and `childLogger({ component: 'foo' })`.
  Logs go to **stderr** so streaming output stays clean. Default level is `info`;
  debug is opt-in via `ATLAS_LOG=debug`.

### Tools (built-ins)

Every tool exports a `Tool<Input>` with: `name`, `description`, `approval` mode,
Zod `schema`, `whenToUse`, `outputContract`, `blockedOps`, `examples`, and
`execute`. All seven metadata fields are required.

- The **`summary` field is the only thing that reaches the model.** Bulk content
  (file text, HTTP body, stdout/stderr) goes in `data.*`. Summaries are head+tail
  truncated via `truncate.ts`; the agent loop enforces a 32 KB hard backstop.
- Auto-approval is the default for *read-only* tools. Anything that mutates the
  workspace is `approval: 'ask'`. Network egress is `approval: 'auto'` only for
  SSRF-guarded paths.
- Path safety: relative paths resolve against `ctx.cwd`. Reject any resolved path
  whose `relative(cwd, abs)` starts with `..`.

### Providers

- Implement the `Provider` interface from `providers/types.ts`.
- Stream events are typed (`delta` / `tool_call*` / `thinking` / `done` / `error`);
  never invent event shapes.
- Token usage merges via `mergeUsage`, **never spread-overwrite.** Partial usage
  payloads carry only the fields they update.
- Prompt-cache markers go on **stable, large** content (system prompt, last static
  tool spec) — never on dynamic per-turn content.

---

## Testing instructions

- **Framework**: Vitest.
- **One test file per source file**: `foo.ts` → `foo.test.ts`.
- **No network in tests.** Mock providers explicitly with the patterns in
  `providers/openrouter.test.ts`.
- **Behavior, not implementation.** Assert on observable output, not internal
  state. No snapshot tests of randomly-ordered structures.
- Use `mkdtemp` + `tmpdir` for FS tests; clean up via `afterEach`.
- Test the failure paths. Every `Result`-returning function should have at least
  one `expect(r.ok).toBe(false)` test.

---

## Security considerations

- **No secrets in code.** API keys come from `~/.atlas/config.yaml` or
  environment variables. Never commit a key, never echo a key to a log line.
- **Path safety** is enforced by the `path-safety` hook and by individual tools:
  reject paths outside `ctx.cwd`, `.git`, `.env`, `~/.ssh`, and similar.
- **Secret redaction** is a built-in hook that scrubs API keys, tokens, and
  private keys from tool output before it reaches the model.
- **Dangerous command blocking** is a built-in hook that blocks obviously
  destructive shell and git commands.
- **Prompt injection detection** flags prompt-injection markers found in tool
  output.
- **URL safety** (`security/url-safety.ts`) blocks SSRF and unsafe outbound
  requests.
- **Approval gating**: all mutating tools require explicit user approval (`ask`)
  unless the user has overridden the mode.

---

## Distribution model

`atlas-os` ships a tiny launcher (`packages/cli/src/launcher.mjs`) as its npm
`bin`. At runtime the launcher tries the matching `atlas-os-<platform>-<arch>`
optional-dep package and execs the embedded `bin/atlas` binary. If that package
isn't installed (unsupported platform, partial publish, or `--ignore-optional`),
it falls back to running the bundled JS at `dist/bin/atlas.js` under Node.

Releases are cut by pushing a `vX.Y.Z` tag. `.github/workflows/release.yml`
cross-compiles all 5 binaries from a single Linux runner with Bun, then uploads
artifacts. Publishing to npm is **opt-in only** (manual workflow dispatch with
`publish=true`). Platform packages are published first so the dispatcher's
optional-dep version is already resolvable when it goes live.

The VS Code extension is built and published via
`.github/workflows/vscode-extension.yml` (also opt-in).

---

## Hard rules (invariants)

These are the rules the codebase must always satisfy. If you find code that
breaks one of these, the code is wrong — not the rule.

1. **No `any`.** All boundaries narrow to typed values via Zod or explicit
   `unknown` + guards. Strict TypeScript settings are non-negotiable.
2. **Cancellation everywhere.** Every async path that can take more than ~100 ms
   accepts and propagates an `AbortSignal`.
3. **Tool `summary` is the only field that reaches the model.** Bulk content goes
   in `data.*`. Summaries are head+tail truncated; the agent loop enforces a 32 KB
   hard backstop.
4. **Prompt-cache markers go on the *last* static block.** Anthropic
   `cache_control` is set on the system prompt and on the last static tool spec —
   never on per-turn dynamic content.
5. **Token usage merges via `mergeUsage`, never spread-overwrite.** Partial usage
   payloads carry only the fields they update.
6. **ESM only.** `"type": "module"` everywhere. Import specifiers use the `.js`
   suffix even when the source is `.ts`.
7. **Skill files start with YAML frontmatter.** Any agent or tool that mutates a
   `SKILL.md` must preserve frontmatter order and the trailing blank line.
8. **Result over throw for control flow.** `Result<T, AtlasError>` from
   `@atlas/core` is the only acceptable error channel for recoverable failures.
   Throwing is reserved for programmer errors.
9. **Customization is layered, never replaced.** Built-in → `~/.atlas/` (user) →
   `<cwd>/.atlas/` (project) deep-merge. Loaders must apply all three layers;
   never short-circuit because user or project is empty.

---

## Workflow for agents

### Before implementing

1. Read `context/project-overview.md`, `ARCHITECTURE.md`, `context/code-standards.md`,
   `context/ai-workflow-rules.md`, and `context/progress-tracker.md` (in that order).
2. If the task touches a file in `packages/`, read the closest `*.test.ts` next
   to it before changing the source.
3. Pick the **smallest change** that advances the current phase. Atlas is built
   in 12-phase vertical slices. Do not ship work that belongs to a later phase.

### Scoping

- Work on **one feature unit at a time**.
- Do not combine unrelated concerns in a single commit. UI changes, provider
  changes, and tool changes are separate commits.
- Do not refactor adjacent code "while you're there".
- Do not add helpers, abstractions, or "improvements" beyond what the task requires.
- Do not add docstrings, comments, or type annotations to code you did not change.

### Split work if it combines

- A provider change **and** a tool change.
- A core change **and** a TUI change (cross-package).
- A change to >5 files **and** a behavior change.
- A schema change **and** a feature using the new schema.

### Verification before "done"

A task is **not done** until:

1. The full quality gate passes (see **Build and test commands**).
2. The change works end to end within its scope.
3. No invariant was violated.
4. `context/progress-tracker.md` reflects what changed.
5. Commit message describes the *what* and *why*, not the *how*.
6. No new `any`, no thrown control-flow exceptions, no async path without an
   `AbortSignal` parameter.

### After commit

- Append a one-line entry under **Recent Decisions** in
  `context/progress-tracker.md` with the commit short SHA + a 5–12 word summary.
- If the change completes a phase, flip its row in the README phase table and
  append a CHANGELOG entry.
- If the change introduces a new invariant or convention, also update
  `ARCHITECTURE.md` or `code-standards.md` in the same commit.

### Protected files

Do not modify the following without an explicit user request:

- `LICENSE`
- `pnpm-lock.yaml` (generated — only `pnpm install` should touch it)
- `packages/*/dist/**` (build output)
- `~/.atlas/` user state outside the project tree
- The Greek-pantheon agent files in `packages/core/src/builtins/agents/` unless
  the task specifically targets them
- The DESIGN.md byte-spec adopted from `@google/design.md` — version bumps
  require explicit review

### Operational safety

- Take local, reversible actions freely (edit files, run tests, build).
- For hard-to-reverse actions, **ask first**: deleting files/branches, `rm -rf`,
  `git push --force`, `git reset --hard`, amending pushed commits, force-pushing,
  sending messages, modifying shared infra.
- Never bypass safety checks. No `--no-verify`, no skipped tests, no commenting
  out failing assertions.
- No shell-level backgrounding (`&`, `nohup`, `disown`) inside scripts the agent
  spawns. Use proper child-process management.

---

## Keeping docs in sync

Update the relevant context file **in the same commit** as the change:

| Change | Update |
|---|---|
| New invariant the codebase must hold | `ARCHITECTURE.md` § Invariants |
| New convention you started enforcing | `context/code-standards.md` |
| New phase shipped or marked in progress | `README.md` phase table + tracker |
| New product feature in/out of scope | `context/project-overview.md` |
| Architectural decision (provider, layout, …) | `context/progress-tracker.md` § Recent Decisions + ADR if material |
| Anything that lands on `main` | `context/progress-tracker.md` short note |
