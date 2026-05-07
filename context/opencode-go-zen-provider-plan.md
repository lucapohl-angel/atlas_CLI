# OpenCode Go and Zen Provider Plan

Last checked: 2026-05-07

Implementation note: Atlas is now OpenTUI-only for the full-screen TUI.
The legacy Ink TUI and `--ui=ink` fallback are retired, so provider UI work
belongs in `packages/cli/src/tui/opentui/` plus shared startup code.

## Goal

Add first-class Atlas support for OpenCode Go and OpenCode Zen as
bring-your-own-key providers.

Users should be able to:

- Paste OpenCode Go and/or OpenCode Zen API keys in `/config`.
- See connected badges for each provider after restart.
- Open `/models` and see fetched OpenCode models under their own categories.
- Select an OpenCode model and have Atlas route requests to the correct
  OpenCode endpoint.

Official OpenCode docs:

- Go: https://opencode.ai/docs/go/
- Zen: https://opencode.ai/docs/zen/
- Providers: https://opencode.ai/docs/providers/
- Terms: https://opencode.ai/legal/terms-of-service

## Terms-Safe Shape

Keep this implementation strictly BYO-key:

- Do use the user's own OpenCode API key.
- Do call only documented OpenCode API endpoints.
- Do respect OpenCode's model catalog and rate/usage limits.
- Do not implement OpenCode OAuth.
- Do not read or import OpenCode CLI credentials from
  `~/.local/share/opencode/auth.json`.
- Do not proxy all Atlas users through a shared Atlas/OpenCode account.
- Do not add key rotation intended to bypass OpenCode Go usage limits.

This keeps Atlas in the clean lane: a local CLI calling official endpoints
with the user's own credentials.

## Existing Atlas Surfaces To Touch

Core config:

- `packages/core/src/config/types.ts`
- `packages/core/src/config/load.ts`
- `packages/core/src/config/load.test.ts`

Core providers:

- `packages/core/src/providers/index.ts`
- `packages/core/src/providers/catalog.ts`
- `packages/core/src/providers/catalog.test.ts`
- new: `packages/core/src/providers/opencode.ts`
- new: `packages/core/src/providers/opencode.test.ts`

CLI startup and routing:

- `packages/cli/src/tui/runTui.ts`
- `packages/cli/src/tui/runTui.test.ts`

OpenTUI:

- `packages/cli/src/tui/opentui/OpenTuiApp.tsx`
- nearby OpenTUI tests if existing coverage needs updates

Docs after implementation:

- `README.md` provider section
- `context/progress-tracker.md` recent decision after commit

## Provider Names

Use these Atlas provider kind strings:

- `opencode-zen`
- `opencode-go`

Use these model id prefixes in Atlas:

- Zen models: `opencode/<model-id>`
- Go models: `opencode-go/<model-id>`

Examples:

- `opencode/gpt-5.5`
- `opencode/claude-sonnet-4.6`
- `opencode-go/kimi-k2.6`
- `opencode-go/glm-5.1`

The provider should strip the Atlas prefix before sending the model id to
OpenCode if the endpoint expects the bare OpenCode model id.

## Phase 1 - Config Schema

In `packages/core/src/config/types.ts`, add an OpenCode config schema.

Suggested shape:

```ts
export const OpenCodePlanProviderConfigSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().url(),
    customModels: z.array(z.string().min(1)).default([])
  })
  .default({});

export const OpenCodeProviderConfigSchema = z
  .object({
    zen: OpenCodePlanProviderConfigSchema.default({
      baseUrl: 'https://opencode.ai/zen/v1'
    }),
    go: OpenCodePlanProviderConfigSchema.default({
      baseUrl: 'https://opencode.ai/zen/go/v1'
    })
  })
  .default({});
```

Then add `opencode: OpenCodeProviderConfigSchema` under
`ProvidersConfigSchema`.

Extend `defaultProvider`:

```ts
z.enum(['openrouter', 'anthropic', 'local', 'opencode-zen', 'opencode-go'])
```

In `packages/core/src/config/load.ts`, support env overrides:

- `OPENCODE_ZEN_API_KEY`
- `OPENCODE_ZEN_BASE_URL`
- `OPENCODE_GO_API_KEY`
- `OPENCODE_GO_BASE_URL`

Add tests in `load.test.ts` for defaults, YAML parsing, and env overrides.

## Phase 2 - Catalog Fetching

In `packages/core/src/providers/catalog.ts`:

1. Extend `ModelProviderKind`:

```ts
export type ModelProviderKind =
  | 'openrouter'
  | 'anthropic'
  | 'openai-codex'
  | 'local'
  | 'opencode-zen'
  | 'opencode-go';
```

2. Add catalog fetchers:

```ts
export const fetchOpenCodeZenModels = async (
  apiKey: string,
  options?: FetchOptions & { readonly baseUrl?: string }
): Promise<Result<readonly ModelInfo[], AtlasError>>;

export const fetchOpenCodeGoModels = async (
  apiKey: string,
  options?: FetchOptions & { readonly baseUrl?: string }
): Promise<Result<readonly ModelInfo[], AtlasError>>;
```

3. Fetch:

- Zen: `${baseUrl}/models`
- Go: `${baseUrl}/models`

4. Send auth as:

```ts
authorization: `Bearer ${apiKey}`
accept: 'application/json'
```

5. Cache using existing cache helpers:

- `opencode-zen-models.json`
- `opencode-go-models.json`

6. Increment `CACHE_SCHEMA_VERSION` if the cached model shape changes.

7. Parse the OpenCode response conservatively:

- accept OpenAI-style `{ data: [{ id, ... }] }`
- accept provider-specific `{ models: [...] }` if OpenCode returns that
- skip malformed rows
- skip models Atlas cannot route yet

8. Assign labels, thinking, and prompt-cache support:

- `label`: display name from response if present, else id
- `thinking`: `['off', 'low', 'medium', 'high']` for GPT/Codex/reasoning
  families, Anthropic heuristic for Claude, else `['off']`
- `promptCache`: `supported` when cache pricing/metadata is present,
  otherwise `unknown`
- `provider`: `opencode-zen` or `opencode-go`

## Phase 3 - Route Classification

Add a shared route helper in `opencode.ts` or `catalog.ts`:

```ts
type OpenCodePlan = 'zen' | 'go';
type OpenCodeRoute = 'responses' | 'messages' | 'chat-completions';

export const openCodeRouteForModel = (
  plan: OpenCodePlan,
  atlasModelId: string
): OpenCodeRoute | null;
```

Initial routing based on OpenCode docs:

Zen:

- `gpt-*`, `o*`, Codex-flavored GPT ids -> `responses`
- `claude-*` -> `messages`
- `qwen*`, `minimax*`, `glm*`, `kimi*`, `big-pickle`, `ling*`,
  `hy3*`, `nemotron*` -> `chat-completions`
- Gemini/Google models -> return `null` for v1 unless Atlas adds a
  Google-compatible route

Go:

- `glm-*`, `kimi-*`, `deepseek-*`, `mimo-*`, `qwen*` ->
  `chat-completions`
- `minimax-m2.5`, `minimax-m2.7` -> `messages`

Use this helper both when cataloging and when sending requests so listed
models are actually callable.

## Phase 4 - Runtime Provider

Create `packages/core/src/providers/opencode.ts`.

Suggested factory:

```ts
export interface OpenCodeProviderOptions {
  readonly plan: 'zen' | 'go';
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

export const createOpenCodeProvider = (
  options: OpenCodeProviderOptions
): Provider;
```

Provider name:

- Zen: `opencode-zen`
- Go: `opencode-go`

Request behavior:

- Strip `opencode/` or `opencode-go/` from `request.model`.
- Determine route with `openCodeRouteForModel`.
- If route is unknown, emit `PROVIDER_INVALID_RESPONSE` or
  `CONFIG_INVALID` as a provider `error` event.
- Propagate `request.signal`.
- Use `Result`/typed error events, not thrown control flow.

Endpoint mapping:

- `responses`: `POST ${baseUrl}/responses`
- `messages`: `POST ${baseUrl}/messages`
- `chat-completions`: `POST ${baseUrl}/chat/completions`

Headers:

```ts
authorization: `Bearer ${apiKey}`
content-type: 'application/json'
accept: 'text/event-stream'
```

Implementation notes:

- Reuse Atlas's existing stream event shapes only.
- Do not invent new `StreamEvent` variants.
- Reuse or carefully mirror existing OpenAI-compatible parsing from
  `local.ts` / `openrouter.ts`.
- Reuse or carefully mirror Anthropic SSE parsing from `anthropic.ts` for
  `/messages`.
- Reuse or carefully mirror Responses parsing from `codex.ts` for
  `/responses`, but do not use ChatGPT-specific headers like
  `originator: codex_cli_rs`.
- Keep the implementation scoped. Extract shared parsing helpers only if
  duplication gets large enough to be riskier than the extraction.

Tests in `opencode.test.ts`:

- sends Bearer auth
- strips Atlas model prefixes
- routes Zen GPT to `/responses`
- routes Zen Claude to `/messages`
- routes Zen Qwen/GLM/Kimi/MiniMax chat models to `/chat/completions`
- routes Go MiniMax M2.5/M2.7 to `/messages`
- routes Go Kimi/GLM/MiMo/Qwen/DeepSeek to `/chat/completions`
- maps 401 to `PROVIDER_AUTH_FAILED`
- maps 429 to `PROVIDER_RATE_LIMITED`
- honors `AbortSignal`
- emits `delta`, `tool_call`, and `done` where the route protocol supports
  them

## Phase 5 - Provider Factory

In `packages/core/src/providers/index.ts`:

- export `opencode.ts`
- import `createOpenCodeProvider`
- add `providerFromConfig` cases for:
  - `opencode-zen`
  - `opencode-go`

Missing key errors should be explicit:

- `OpenCode Zen API key missing - set OPENCODE_ZEN_API_KEY or providers.opencode.zen.apiKey`
- `OpenCode Go API key missing - set OPENCODE_GO_API_KEY or providers.opencode.go.apiKey`

## Phase 6 - Startup Catalog and Runtime Map

In `packages/cli/src/tui/runTui.ts`:

1. Update `RuntimeProviderKind` usage by relying on the expanded
   `ModelProviderKind`.

2. Update `providerKindForStartupModel`:

- `opencode-go/...` -> `opencode-go`
- `opencode/...` -> `opencode-zen`
- then existing OpenRouter/Anthropic/Codex/local heuristics

3. Update `firstConnectedCatalogModel` fallback ordering.

Suggested order:

1. local
2. anthropic
3. openai-codex
4. opencode-go
5. opencode-zen
6. openrouter

This can be adjusted, but keep it deterministic.

4. Update `loadModelCatalog`:

- when `cfg.providers.opencode.zen.apiKey`, push
  `fetchOpenCodeZenModels(...)`
- when `cfg.providers.opencode.go.apiKey`, push
  `fetchOpenCodeGoModels(...)`
- keep provider/id dedupe key as `${m.provider}:${m.id}`

5. Update `buildAllProviders`:

- add `opencode-zen` runtime when Zen key exists
- add `opencode-go` runtime when Go key exists

6. Update `runTui.test.ts` for startup model selection and runtime provider
   routing.

## Phase 7 - Model Picker UI

OpenTUI: `packages/cli/src/tui/opentui/OpenTuiApp.tsx`

- Extend provider kind unions, picker provider group order, and
  provider tag/long-label helpers.
- Add `PROVIDER_TAG` entries:
  - `opencode-go`: `GO`
  - `opencode-zen`: `ZEN`
- Add group order entries and section labels.
- Update `switchToModel` and `withSelectedDefaultModel`.

Suggested `/models` grouping order:

```text
-- Local (Ollama / LM Studio) --
-- Anthropic --
-- OpenAI (ChatGPT / Codex) --
-- OpenCode Go --
-- OpenCode Zen --
-- OpenRouter --
```

## Phase 8 - /config UI

OpenTUI needs two new config rows:

- `OpenCode Zen API key`
- `OpenCode Go API key`

Each row should support:

- disconnected state
- connected badge
- set key
- replace key
- disconnect/remove key

Existing helper patterns:

- OpenTUI: `saveProviderKey` / `removeProviderKey` in
  `packages/cli/src/tui/opentui/OpenTuiApp.tsx`

Recommended cleanup:

- Generalize `saveProviderKey` and `removeProviderKey` from
  `'openrouter' | 'anthropic'` to include:
  - `opencode-zen`
  - `opencode-go`
- For OpenCode keys, do not support comma-separated fallback rotation in
  v1 unless there is a real user need. Avoid anything that looks like
  usage-limit bypassing.

Config help text:

- Zen key URL: `https://opencode.ai/auth`
- Go key URL: `https://opencode.ai/auth`
- Say: "Use your own OpenCode API key. Atlas does not read OpenCode CLI
  auth files."

## Phase 9 - Docs

Update README provider docs with a short section:

```yaml
providers:
  opencode:
    zen:
      apiKey: ${OPENCODE_ZEN_API_KEY}
    go:
      apiKey: ${OPENCODE_GO_API_KEY}
```

Mention:

- Go is subscription-based and beta per OpenCode docs.
- Zen is pay-as-you-go/credit based per OpenCode docs.
- Atlas uses official OpenCode API keys and endpoints.
- Atlas does not reuse OpenCode CLI auth.

If this lands on `main`, append a one-line recent decision in
`context/progress-tracker.md`.

## Phase 10 - Verification

Required repo gates:

```bash
pnpm --filter @atlas/core build
pnpm --filter @atlas/core test:run
pnpm --filter atlas-os typecheck
pnpm --filter atlas-os test:run
pnpm --filter atlas-os build
```

Manual checks:

1. Add only Zen key in `/config`, restart, confirm Zen section appears in
   `/models`.
2. Add only Go key in `/config`, restart, confirm Go section appears in
   `/models`.
3. Pick one Go chat-completions model and send a simple prompt.
4. Pick one Go messages model if available and send a simple prompt.
5. Pick one Zen responses model and send a simple prompt.
6. Pick one Zen messages model and send a simple prompt.
7. Remove keys in `/config`, restart, confirm sections disappear.

## Suggested GitHub Issue Response

Yes, this is feasible in a ToS-safe way as BYO-key provider support. Atlas
would add OpenCode Go and OpenCode Zen as normal provider options, store the
user's own OpenCode API keys in `~/.atlas/config.yaml` or env vars, fetch
models from OpenCode's documented `/models` endpoints, and show those models
under their own `/models` categories. We should not implement OpenCode OAuth,
read OpenCode's local auth file, proxy through a shared account, or do
anything intended to bypass OpenCode usage limits.
