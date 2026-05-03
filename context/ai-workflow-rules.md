# Atlas — AI Workflow Rules

> Direct instructions to any AI agent (Claude Code, Codex, Atlas itself,
> a subagent) working on this repository. These are rules, not
> guidelines. If you're about to violate one, stop and ask the user.

## Read-first list

Before implementing anything in this repo, read in this order:

1. [`context/project-overview.md`](./project-overview.md) — what Atlas
   is and isn't.
2. [`ARCHITECTURE.md`](../ARCHITECTURE.md) — engine layout, package
   split, SDD pipeline, **invariants**.
3. [`context/code-standards.md`](./code-standards.md) — strict-TS,
   ESM, Result, Zod, tool contract.
4. [`context/ai-workflow-rules.md`](./ai-workflow-rules.md) — this
   file.
5. [`context/progress-tracker.md`](./progress-tracker.md) — current
   phase, in-progress work, open questions, recent decisions.
6. [`README.md`](../README.md) — phase tables (1.0 + post-1.0 SDD)
   and quickstart. Skim only — full detail is in the files above.

If a task touches a file in `packages/`, also read the closest
`*.test.ts` next to it before changing the source.

## Approach

- **Spec-driven, vertical-slice.** Atlas is built in 12-phase tracks.
  Pick the smallest change that advances the **current** phase. Do not
  ship work that belongs to a later phase, even if you have time.
- **Implement, don't suggest.** When the user's request is concrete,
  make the change. Read enough context to act confidently, then act.
- **Test boundaries first.** When a contract is testable in isolation
  (parser, planner, pure function), write the test before the
  implementation.

## Scoping rules

- Work on **one feature unit at a time**. A unit produces one visible,
  verifiable result and stays within one system boundary
  (provider / tool / hook / skill / agent / session / TUI / CLI).
- Do not combine unrelated concerns in a single commit. UI changes,
  provider changes, and tool changes are three commits, not one.
- Do not refactor adjacent code "while you're there". File a note in
  the progress tracker and move on.
- Do not add helpers, abstractions, or "improvements" beyond what the
  task requires.
- Do not add docstrings, comments, or type annotations to code you did
  not change.

## When to split work

Split an implementation step if it combines:

- A provider change **and** a tool change.
- A core change **and** a TUI change (cross-package).
- A change to >5 files **and** a behavior change. Either it's a pure
  rename (mechanical) or a focused behavior change (small surface).
- A schema change **and** a feature using the new schema. Land the
  schema first with tests, then the feature.

If you cannot describe the unit's "done" state in one sentence, the
scope is too broad. Split.

## Handling missing or ambiguous requirements

- **Do not invent product behavior** that isn't in the project overview
  or architecture.
- If a requirement is ambiguous: resolve it in the relevant context
  file before implementing. The fix is "update the docs", not "guess
  and ship".
- If a requirement is missing: add it to **Open Questions** in
  [progress-tracker.md](./progress-tracker.md) and ask the user before
  continuing.
- If a third-party API behaves differently than documented: capture
  the discovery in **Recent Decisions** with a one-line link to the
  evidence (commit, response payload, doc URL).

## Protected files

Do not modify the following without an explicit user request:

- `LICENSE`
- `pnpm-lock.yaml` (generated — only `pnpm install` should touch it)
- `packages/*/dist/**` (build output)
- `~/.atlas/` user state outside the project tree
- The Greek-pantheon agent files in `packages/core/src/builtins/agents/`
  unless the task specifically targets them
- The DESIGN.md byte-spec adopted from `@google/design.md` — version
  bumps require explicit review

## Operational safety

- Take local, reversible actions freely (edit files, run tests, build).
- For hard-to-reverse actions, **ask first**: deleting files/branches,
  `rm -rf`, `git push --force`, `git reset --hard`, amending pushed
  commits, force-pushing, sending messages, modifying shared infra.
- Never bypass safety checks. No `--no-verify`, no skipped tests, no
  commenting out failing assertions.
- No shell-level backgrounding (`&`, `nohup`, `disown`) inside scripts
  the agent spawns. Use proper child-process management.
- Secrets come from `~/.atlas/config.yaml` or env vars. Never commit a
  key, never echo a key to a log line.

## Keeping docs in sync

Update the relevant context file **in the same commit** as the change:

| Change                                         | Update                                  |
| ---------------------------------------------- | --------------------------------------- |
| New invariant the codebase must hold           | `ARCHITECTURE.md` § Invariants          |
| New convention you started enforcing           | `context/code-standards.md`             |
| New phase shipped or marked in progress        | `README.md` phase table + tracker       |
| New product feature in/out of scope            | `context/project-overview.md`           |
| Architectural decision (provider, layout, …)   | `context/progress-tracker.md` § Recent Decisions + ADR if material |
| Anything that lands on `main`                  | `context/progress-tracker.md` short note |

## Verification before "done"

A task is **not done** until all of the following pass:

```bash
pnpm --filter @atlas/core build
pnpm --filter @atlas/core test:run
pnpm --filter atlas-cli typecheck
pnpm --filter atlas-cli test:run
pnpm --filter atlas-cli build
```

Plus:

1. The change works end to end within its scope (manually verified or
   covered by a new test).
2. No invariant in `ARCHITECTURE.md` § Invariants was violated.
3. `context/progress-tracker.md` reflects what changed.
4. Commit message describes the *what* and *why*, not the *how*.
5. No new `any`, no thrown control-flow exceptions, no async path
   without an `AbortSignal` parameter.

If any gate fails, do not commit. Fix or ask.

## After commit

- Append a one-line entry under **Recent Decisions** in
  [progress-tracker.md](./progress-tracker.md) with the commit short
  SHA + a 5-12 word summary.
- If the change completes a phase, flip its row in the README phase
  table and append a CHANGELOG entry.
- If the change introduces a new invariant or convention, also update
  `ARCHITECTURE.md` or `code-standards.md` in the same commit.

## When stuck

- Do not brute-force. Two failed attempts at the same approach is the
  signal to stop and reconsider.
- Search for prior art in the repo before inventing. Most patterns
  (Result, Zod boundaries, head+tail truncation, mergeUsage,
  approval-gated tools) already exist somewhere.
- Use the `Explore` subagent for read-only investigation rather than
  cluttering the main session with many small file reads.
