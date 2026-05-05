# AGENTS.md

> Guidance for AI agents (Codex CLI, Claude Code, Atlas itself, anything else)
> working on this repository.

## Read these first (in order)

1. [`context/project-overview.md`](context/project-overview.md) — what
   Atlas is, the user flow, in/out of scope, success criteria.
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — engine layout, SDD pipeline,
   and the **Invariants** section (rules the codebase must always
   satisfy).
3. [`context/code-standards.md`](context/code-standards.md) — strict TS,
   ESM, Result, Zod, tool contract, testing conventions.
4. [`context/ai-workflow-rules.md`](context/ai-workflow-rules.md) —
   scoping, splitting, protected files, verification gates,
   doc-update rules. **The hard rules below are summarized; the full
   rules live there.**
5. [`context/progress-tracker.md`](context/progress-tracker.md) —
   current phase, in-progress work, open questions, recent decisions.
6. [`README.md`](README.md) — quickstart and phase tables.

If you only have time for two files, read 1 and 5.

## Hard rules

- **No partial code.** Every PR/commit must compile, typecheck, lint, and pass
  tests. Run `pnpm typecheck && pnpm test:run && pnpm lint` before declaring a
  task complete.
- **No `any`.** TypeScript strict mode is enforced. Prefer `unknown` + Zod
  parsing at boundaries. If you genuinely need `any`, justify it in a code
  comment.
- **No exceptions for control flow.** Use `Result<T, E>` from `@atlas/core`.
  Throw only for programmer errors.
- **Cancellation everywhere.** Every async path that can take more than a few
  hundred milliseconds must accept and propagate an `AbortSignal`.
- **No shell-level backgrounding** (`&`, `nohup`) inside scripts the agent
  spawns. Use proper child-process management.
- **No secrets in code.** API keys come from `~/.atlas/config.yaml` or
  environment variables.
- **Deterministic output by default.** Use seeded randomness (`Math.random()`
  is fine for non-critical paths but document when it matters).

## Project structure

```
atlas_CLI/
├── packages/
│   ├── core/        @atlas/core — engine (providers, tools, hooks, skills, agents, orchestrator)
│   ├── cli/         atlas-os — bin entry, REPL, command parsing
│   └── binaries/    per-platform npm packages that ship a Bun-compiled
│                    `atlas` executable. Published as optionalDependencies
│                    of atlas-os. Built by scripts/build-binaries.mjs.
├── scripts/
│   └── build-binaries.mjs   bun build --compile per target (linux-x64,
│                            linux-arm64, darwin-x64, darwin-arm64,
│                            win32-x64). Requires Bun on the build host.
├── .github/workflows/
│   └── release.yml          tag-triggered cross-compile + npm publish
├── tsconfig.base.json
├── pnpm-workspace.yaml
└── package.json     monorepo root
```

### Distribution model

`atlas-os` ships a tiny launcher (`packages/cli/src/launcher.mjs`) as its
npm `bin`. At runtime the launcher tries the matching
`atlas-os-<platform>-<arch>` optional-dep package and execs the embedded
`bin/atlas` binary. If that package isn't installed (unsupported
platform, partial publish, or `--ignore-optional`), it falls back to
running the bundled JS at `dist/bin/atlas.js` under Node.

Releases are cut by pushing a `vX.Y.Z` tag. `release.yml` cross-compiles
all 5 binaries from a single Linux runner with Bun, then publishes the 5
platform packages **first** and the dispatcher last.

## Workflow

1. Pick the smallest change that advances the current phase.
2. Write the test(s) first when the contract is testable in isolation.
3. Implement.
4. Run quality gates:
   `pnpm --filter @atlas/core build && pnpm --filter @atlas/core test:run && pnpm --filter atlas-os typecheck && pnpm --filter atlas-os test:run && pnpm --filter atlas-os build`
5. Update the README phase table when a phase completes.
6. Append a one-line entry to
   [`context/progress-tracker.md`](context/progress-tracker.md) §
   Recent Decisions after every commit on `main`
   (`[shortsha] one-line summary`). Move stale items out of
   "In Progress" / "Next Up" in the same edit.

## Phases

Atlas is built in 12 vertical slices. Each phase ships a working CLI. Do not
work ahead of the current phase — finish the current slice cleanly before
moving on.

See README.md for the phase list.

## Coding style

- ESM only (`"type": "module"`). Use `.js` extensions in import specifiers.
- Strict TypeScript. `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, etc.
- Zod for any I/O boundary (config, tool input, provider response).
- Pino (`@atlas/core` `logger`) for diagnostics. Logs go to stderr.
- File names: kebab-case. Type names: PascalCase. Functions/variables: camelCase.
- Prefer `readonly`, `as const`, and immutable updates over mutation.

## Testing

- Vitest. One test file per source file: `foo.ts` → `foo.test.ts`.
- Tests must run without network access. Mock providers explicitly.
- Aim for behavior-focused tests, not implementation snapshots.
