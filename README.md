# Atlas CLI

> Your autonomous development crew. Multi-agent, hook-driven, model-agnostic.

Atlas is a terminal-first AI coding agent that orchestrates a crew of specialized
sub-agents — named after the Greek pantheon — through the full software lifecycle:
requirements, architecture, story breakdown, implementation, QA, and delivery.

It is **model-agnostic** (defaults to OpenRouter, supports Anthropic / OpenAI /
Google / Ollama natively), **hook-driven** (typed pre/post lifecycle events, with
real blocking semantics), and **skill-extensible** (Hermes-style on-demand skills
loaded by the active agent based on context).

## Status

Atlas is built in vertical slices. Each phase ships a working CLI with progressively
more capability.

| Phase | Status | Capability |
| ----- | ------ | ---------- |
| 0     | ✅     | Foundation: monorepo, tests, build, `atlas --version`, `atlas doctor` |
| 1     | ✅     | Single-turn streaming chat against OpenRouter (`atlas ask`) |
| 2     | ✅     | Interactive REPL (`atlas chat`) with slash-commands and Ctrl-C cancellation |
| 3     | ✅     | Tool system (`read_file`, `write_file`, `terminal`) with approval modes |
| 4     | ✅     | Hook system: typed pre/post lifecycle events |
| 5     | ✅     | Skills system (Hermes-style on-demand `SKILL.md`) |
| 6     | ✅     | MCP client (stdio transport) |
| 7     | ✅     | Agents system (Greek god personas, handoff triggers) |
| 8     | ✅     | Orchestrator: project state → recommended agent (`atlas status`) |
| 9     | ✅     | Context window manager (auto-compact at 80%) |
| 10    | ✅     | Sessions: persistent JSON transcripts with audit log |
| 11    | ✅     | Built-in agents + starter skills (`atlas init`) |
| 12    | ✅     | Polish: docs, changelog, lint, publish-ready scripts |

### Post-1.0 SDD pipeline (current track)

A second 12-phase track turns Atlas into a complete spec-driven-delivery
crew. Phases 1–6 are shipped; 7–11 are queued (installer/module system
deferred). Each post-1.0 phase ships a working, fully tested slice.

| Phase | Status | Capability |
| ----- | ------ | ---------- |
| 1     | ✅     | Persona DNA: voice, activation, boundaries, examples, dataRefs |
| 2     | ✅     | Tool quality: `whenToUse`, contract, blocked-by, examples |
| 3     | ✅     | Templates engine + 16 starter templates (Handlebars + Zod) |
| 4     | ✅     | Checklists engine + 17 starter checklists + DESIGN.md adoption |
| 5     | ✅     | Workflow chains + handoff-aware orchestrator (`*next`, `atlas status`) |
| 6     | ✅     | Skill versioning, `/skills` toggle, `atlas *next` |
| 7     | ✅     | Docs + examples (this section, `examples/`, ARCHITECTURE refresh) |
| 8     | ⏳     | Sectioned long-form templates (per-section render/write for PRD/architecture) |
| 9     | ⏳     | Project state file (`<cwd>/.atlas/state.yaml` — sprint/artifact status) |
| 10    | ⏳     | Workflow gates + activation hooks (`requires`, HALT, prepend/append/on_complete) |
| 11    | ⏳     | Customization overlays (built-in → user → project deep-merge) |
| 12    | ⏸     | Installer + module system (deferred) |

See [`examples/sdd-walkthrough.md`](./examples/sdd-walkthrough.md) for an
end-to-end run: brief → PRD → architecture → UX → design system → epics →
story → implementation → QA.

## Quick start

```bash
git clone https://github.com/lucapohl-angel/atlas_CLI.git
cd atlas_CLI
pnpm install
pnpm build
node packages/cli/dist/bin/atlas.js doctor

# Phase 1: single-turn chat. Set your OpenRouter key first.
export OPENROUTER_API_KEY=sk-or-...
node packages/cli/dist/bin/atlas.js ask "explain monads in one sentence"

# Phase 11: install built-in Greek-god agents and starter skills
node packages/cli/dist/bin/atlas.js init

# Phase 8: see what the orchestrator recommends for the current project
node packages/cli/dist/bin/atlas.js status

# Phase 2: drop into the interactive REPL (default command)
node packages/cli/dist/bin/atlas.js chat
```

Config file (optional) at `~/.atlas/config.yaml`:

```yaml
defaultModel: anthropic/claude-sonnet-4
providers:
  openrouter:
    apiKey: sk-or-...        # or set OPENROUTER_API_KEY
    title: Atlas CLI
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design — packages, tool
contract, hook protocol, skill / agent distinction, orchestration loop.

See [AGENTS.md](./AGENTS.md) for guidance to AI agents (Codex, Claude Code, Atlas
itself) working on this repository.

## Greek pantheon

| Role        | God        | Domain                                   |
| ----------- | ---------- | ---------------------------------------- |
| PM          | Athena     | Strategic wisdom, deliberate planning    |
| Architect   | Prometheus | Forethought, system design               |
| Scrum Master| Hestia     | Hearth-keeper, bringer of order          |
| Developer   | Hercules   | The Twelve Labors — relentless execution |
| QA          | Nemesis    | Retribution against hubris (bugs)        |
| DevOps      | Iris       | Messenger between realms (dev → prod)    |
| Analyst     | Apollo     | Truth, prophecy, research                |
| UX          | Aphrodite  | Beauty, aesthetics, feel                 |

> Note: phase 11 ships these as full agent definitions. Earlier phases use
> generic personas while infrastructure stabilizes.

## License

MIT — see [LICENSE](./LICENSE).
