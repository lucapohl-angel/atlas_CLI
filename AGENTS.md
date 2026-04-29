# AGENTS.md

> Guidance for AI agents (Codex CLI, Claude Code, Atlas itself, anything else)
> working on this repository.

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
│   └── cli/         atlas-cli — bin entry, REPL, command parsing
├── tsconfig.base.json
├── pnpm-workspace.yaml
└── package.json     monorepo root
```

## Workflow

1. Pick the smallest change that advances the current phase.
2. Write the test(s) first when the contract is testable in isolation.
3. Implement.
4. Run quality gates (`pnpm typecheck && pnpm test:run`).
5. Update the README phase table when a phase completes.

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
