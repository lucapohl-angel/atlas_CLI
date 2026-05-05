# Atlas — Code Standards

> Conventions that the codebase actually enforces (or *should* enforce —
> if a rule here is violated in code, fix the code, not the rule). When
> in doubt, match the patterns in [packages/core/src/result.ts](../packages/core/src/result.ts)
> and [packages/core/src/tools/read-file.ts](../packages/core/src/tools/read-file.ts).

## General

- Smallest change that advances the current phase. No speculative
  refactors, no "while I'm here" clean-ups bundled into feature work.
- Fix root causes, not symptoms. If a test fails, find why, do not
  weaken the assertion.
- One concern per module. If a file imports from three unrelated
  packages and exports four unrelated symbols, split it.
- Public types come from a single barrel (`packages/core/src/index.ts`).
  Internal helpers stay private to their module.

## TypeScript

- **Strict mode is mandatory.** `strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `exactOptionalPropertyTypes` — see
  [tsconfig.base.json](../tsconfig.base.json).
- **No `any`.** Use `unknown` and narrow with Zod or `typeof`/`in`
  guards. If you genuinely need `any`, leave a one-line comment naming
  the bug-or-third-party reason.
- **No exceptions for control flow.** Return `Result<T, AtlasError>`
  from `@atlas/core/result`. Throw only for programmer errors
  (impossible-state assertions). External calls that throw are caught
  and converted at the boundary.
- **Validate at I/O boundaries.** Provider responses, tool inputs,
  config files, MCP messages — every byte that crosses a process
  boundary goes through Zod (or an equivalent typed parse) before
  business code touches it.
- **`readonly` and immutable updates** by default. Mutate only inside
  the function that owns the value.
- **`as const`** for literal types and discriminator unions. Prefer
  discriminated unions over enums.

## ESM

- `"type": "module"` everywhere. Use `.js` extensions in import
  specifiers — `import { foo } from './bar.js'`, not `'./bar'` or
  `'./bar.ts'`. TypeScript with `verbatimModuleSyntax` will not rewrite
  them for you.
- `import type { … }` for type-only imports.
- Named exports only. No default exports (they break tree-shaking and
  rename consistency).

## Async + cancellation

- **Every async path that can take more than a few hundred milliseconds
  accepts an `AbortSignal`** and propagates it down. If you're calling
  `fetch`, `spawn`, a provider stream, or any tool — pass the signal.
- Check `signal.aborted` at the top of long loops and after every
  awaited boundary.
- Hosts wire user cancel (Ctrl-C, `/abort`) into a single
  `AbortController`. Tools, providers, and hooks share the same signal.

## Errors + logging

- Use `atlasError(code, message, { cause, context })`. New codes go in
  [errors.ts](../packages/core/src/errors.ts) with a doc comment.
- `Result.err(atlasError(...))` over throwing. Callers pattern-match.
- Pino via `@atlas/core/logger` and `childLogger({ component: 'foo' })`.
  Logs go to **stderr** so streaming output stays clean. Default level
  is `info`; debug is opt-in via `ATLAS_LOG=debug`.

## File layout + naming

- File names: `kebab-case.ts`. Test files sit beside source as
  `foo.test.ts`. No `__tests__/` folders.
- Type names: `PascalCase`. Functions / variables / constants:
  `camelCase`. Module-level constants that are genuinely constant:
  `SCREAMING_SNAKE` (rare).
- One public concept per file. Helpers with no callers outside the
  module stay un-exported.

## Tools (Atlas built-ins)

- Every tool exports a `Tool<Input>` with: `name`, `description`,
  `approval` mode, Zod `schema`, `whenToUse`, `outputContract`,
  `blockedOps`, `examples`, and `execute`. All seven metadata fields
  are required — they are what the agent reads to decide *when* to use
  the tool.
- The **`summary` field is the only thing that reaches the model**.
  Bulk content (full file text, full HTTP bodies, full stdout/stderr)
  goes in `data.*`. Truncate `summary` aggressively — see
  [truncate.ts](../packages/core/src/tools/truncate.ts).
- Auto-approval is the default for *read-only* tools. Anything that
  mutates the workspace is `approval: 'ask'`. Network egress is
  `approval: 'auto'` only for SSRF-guarded paths (`safeFetch`).
- Path safety: relative paths resolve against `ctx.cwd`. Reject any
  resolved path whose `relative(cwd, abs)` starts with `..`.

## Providers

- Implement the `Provider` interface from
  [providers/types.ts](../packages/core/src/providers/types.ts). Stream
  events are typed (`delta` / `tool_call*` / `thinking` / `done` /
  `error`); never invent event shapes.
- Token usage is built incrementally with `mergeUsage`. **Never**
  spread-overwrite — partial usage payloads (e.g. Anthropic
  `message_delta`) carry only the fields they update; clobbering
  resets `promptTokens` to zero.
- Prompt caching: `cache_control: { type: 'ephemeral' }` markers go on
  **stable, large** content (system prompt, last static tool spec) —
  never on dynamic per-turn content. Cached tokens roll into
  `promptTokens` and are also reported via `cacheReadTokens` /
  `cacheCreationTokens`.

## Styling (TUI)

- Ink components live under `packages/cli/src/tui/`.
- No raw colors in component code. Use the centralized palette /
  helpers. Status conventions: `green` = ok, `yellow` = warning /
  in-progress, `red` = error, `cyan` = highlight, `gray` = dim/meta.
- Layout: header (one row) + scrollable transcript + footer / input.
  Overlays are full-width modal blocks rendered above the transcript.

## Testing

- **Vitest.** One test file per source file: `foo.ts` → `foo.test.ts`.
- **No network in tests.** Mock providers explicitly with the patterns
  in [providers/openrouter.test.ts](../packages/core/src/providers/openrouter.test.ts).
- **Behavior, not implementation.** Assert on observable output, not
  internal state. No snapshot tests of randomly-ordered structures.
- Use `mkdtemp` + `tmpdir` for FS tests; clean up via `afterEach` if
  the test creates long-lived state.
- Test the failure paths. Every Result-returning function should have at
  least one `expect(r.ok).toBe(false)` test.

## Build + lint gate

Before declaring any task complete, run:

```bash
pnpm --filter @atlas/core build && \
pnpm --filter @atlas/core test:run && \
pnpm --filter atlas-os typecheck && \
pnpm --filter atlas-os test:run && \
pnpm --filter atlas-os build && \
pnpm lint
```

`pnpm lint` runs a dependency-free repository text hygiene check
(trailing whitespace + merge conflict markers) and each package's
TypeScript lint/typecheck script. Do not paper over failures with
`--no-verify` or skipped tests.

## Performance posture

- **Truncate before sending to the model.** `truncateForLLM` (head+tail
  with line-snapping) is the canonical helper. The agent-loop has a
  32 KB hard backstop; tools should hit it well below that.
- **Cache when invalidation is cheap.** `read_file` caches by
  `(path, mtimeMs, size, maxBytes)` — same payload, faster turn. Don't
  cache anything where invalidation is hand-wavy.
- **Cheap model for side work.** Background tasks (compaction
  summaries, skill reflection) read `routerModel` from config and fall
  back to the active model when unset.
