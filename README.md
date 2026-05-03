<div align="center">

# ATLAS·OS

**Autonomous Teams · Lifecycle · Agents · Skills — Orchestration System**

A multi-agent, hook-driven, model-agnostic engineering OS for the terminal.
Hand it a vague idea. Get back a planned, built, tested, committed feature —
with a Greek pantheon of specialist agents doing the work.

[![npm version](https://img.shields.io/npm/v/atlas-os?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/atlas-os)
[![npm downloads](https://img.shields.io/npm/dm/atlas-os?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/atlas-os)
[![GitHub stars](https://img.shields.io/github/stars/lucapohl-angel/atlas_CLI?style=for-the-badge&logo=github&color=181717)](https://github.com/lucapohl-angel/atlas_CLI)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

<br>

```bash
npx atlas-os@latest chat
```

**Works on Mac, Windows, and Linux. Bring any model — Claude, GPT, Gemini, local Ollama, OpenRouter.**

<br>

<!--
  TODO: drop a real screenshot/SVG of the Atlas TUI here.
  Suggested: a 2-3 panel image showing (1) `atlas chat` Ink REPL,
  (2) the orchestrator routing to a Greek-god agent,
  (3) a tool call streaming in.
  Save it to assets/atlas-os.svg or .png and reference below.
-->
<!-- ![Atlas·OS](assets/atlas-os.svg) -->

<br>

[Why I Built This](#why-i-built-this) ·
[Who It's For](#who-its-for) ·
[How It Compares](#how-it-compares) ·
[How It Works](#how-it-works) ·
[Install](#install) ·
[The Pantheon](#the-pantheon) ·
[Why It Works](#why-it-works) ·
[Walkthrough](./examples/sdd-walkthrough.md)

</div>

---

## Why I Built This

I'm one person. I don't write most of my code by hand — the agent does. The
problem is that nearly every "AI coding tool" pretends to be a junior dev with
a chat box: you type, it types back, you paste, repeat. That works for
snippets. It falls apart the moment you try to build a *project*.

The other half of the market overcorrects. SDD frameworks ship sprint
ceremonies, story points, retros, and a Jira-shaped workflow that makes sense
when you have 50 engineers and zero of them speak the same language. I don't
have 50 engineers. I have a model and a terminal.

Atlas·OS is the thing in between. The complexity is in the system, not in your
process. Behind the scenes: typed tool contracts, blocking lifecycle hooks,
skill auto-loading, a chain-routed orchestrator, a six-file context pack
injected into every system prompt, and a roster of specialist sub-agents
named after Greek gods because life is short. What you see: a REPL where you
describe what you want and the right specialist takes the next step.

It is **model-agnostic on purpose**. Atlas does not assume Claude. It does not
assume Anthropic. It does not assume the cloud. The same crew runs against
OpenRouter, OpenAI, Anthropic, Google, or a local Ollama with one config line.

This isn't a wrapper around `claude --dangerously-skip-permissions`. It's an
orchestration system that happens to ship a beautiful CLI.

— **Atlas**

---

## Who It's For

People who want to **describe what to build** and have it built correctly,
without pretending to run a 50-person engineering org and without locking
themselves into one model vendor.

- **Solo founders & indie devs** — One person, multiple "specialists" doing
  spec-driven work for you. PM writes the PRD; architect locks the design;
  scrum master breaks it into stories; dev implements; QA verifies; ship.
- **Agent enthusiasts who hit the wall with single-agent CLIs** — Multi-agent
  by default. Each phase has an owner with its own persona, tool whitelist,
  and skill set.
- **Teams who want quality gates without ceremonies** — Built-in checklists
  catch real problems (missing migrations, contradictions in slot state,
  unreviewed schema changes) instead of asking you to attend a meeting.
- **Engineers who refuse to be married to a model vendor** — Switch from
  Sonnet to GPT-5 to a local Llama in the same session with `/model`.
- **Anyone tired of "vibecoded" sludge** — Atlas's pipeline (discover → plan →
  implement → verify → ship) writes context-pack-grounded code with atomic
  commits, not freestyled garbage.

---

## How It Compares

| | **Atlas·OS** | Claude Code | Aider | Cursor Agent | GSD |
|---|---|---|---|---|---|
| Model-agnostic | ✅ Anthropic / OpenAI / Google / OpenRouter / Ollama | ❌ Claude only | ✅ Many | ⚠️ Claude/GPT | ❌ Claude only |
| Multi-agent by default | ✅ 8+ Greek-god personas | ❌ Single agent | ❌ Single agent | ⚠️ Sub-agent on demand | ✅ Subagents |
| Spec-driven pipeline (PRD→arch→stories→impl→QA) | ✅ Built-in chain | ❌ DIY | ❌ DIY | ❌ DIY | ✅ Phases |
| Typed tool contracts + approval modes | ✅ Zod + auto/ask/never | ⚠️ Permissions JSON | ⚠️ Yes/no | ⚠️ Permissions | ⚠️ Bash allow-list |
| Blocking lifecycle hooks (pre/post tool, vagueness, secrets, paths) | ✅ Typed events | ❌ | ❌ | ❌ | ⚠️ Hooks |
| On-demand skill loading (`SKILL.md`) | ✅ Activation triggers | ✅ Skills | ❌ | ❌ | ⚠️ Skill files |
| Six-file context pack auto-injected | ✅ Cache-friendly system prompt prefix | ❌ | ❌ | ❌ | ⚠️ Context engineering files |
| MCP client | ✅ stdio | ✅ | ⚠️ | ✅ | ✅ |
| Workflow chains + handoffs | ✅ State-aware routing | ❌ | ❌ | ❌ | ✅ |
| One install, terminal-first | ✅ `npx atlas-os` | ✅ | ✅ | ❌ Editor-bound | ✅ Skill installer |

**The short version:** Atlas·OS is what you get when you take the best ideas
from spec-driven development tools, strip out the enterprise theater, and put
them on top of a real engine — typed, hook-enforced, model-agnostic, and
built to work with whatever model you can afford this month.

---

## Install

```bash
# One-shot (no global install — runs the latest)
npx atlas-os@latest chat

# Or install globally
npm install -g atlas-os
atlas chat
```

**Set a key for your provider of choice** (any one of these works):

```bash
export OPENROUTER_API_KEY=sk-or-...     # default — gives you every model
export ANTHROPIC_API_KEY=sk-ant-...     # Claude direct
export OPENAI_API_KEY=sk-...            # GPT direct
export GOOGLE_API_KEY=...               # Gemini direct
# Or just run an Ollama model locally — no key required
```

Or drop a config file at `~/.atlas/config.yaml`:

```yaml
defaultProvider: openrouter
defaultModel: anthropic/claude-sonnet-4.5
providers:
  openrouter:
    apiKey: sk-or-...
    title: My Project
```

Then bootstrap your project:

```bash
atlas init       # install built-in agents, skills, templates, checklists
atlas status     # the orchestrator tells you what to do next
atlas chat       # drop into the REPL
```

---

## How It Works

Atlas runs a **spec-driven delivery pipeline** with a Greek pantheon of
specialist agents. You don't pick which agent to talk to — the orchestrator
does, based on your project's state.

### 1. `atlas init` — Bootstrap

Installs built-in agents, skills, templates, checklists, and workflow chains
into `~/.atlas/`. Reads any `<cwd>/.atlas/` overrides. Creates the six-file
**Context Pack** (`context/project-overview.md`, `code-standards.md`,
`ai-workflow-rules.md`, `progress-tracker.md`) that every agent reads on every
turn — cached at the prompt prefix so it costs almost nothing per call.

### 2. `atlas chat` — The REPL

A full Ink TUI: streaming output, inline tool approvals, slash-commands,
session save/restore, model switcher, MCP server browser, and a status bar
that shows you which agent is active and what phase you're in.

### 3. The orchestrator picks the next agent

Atlas detects what your project has (`PRD?`, `architecture?`, `stories?`,
`context pack?`, `code?`) and routes you to the right specialist:

```
no PRD            →  Athena       (PM — writes PRD)
PRD only          →  Prometheus   (architect — locks design)
arch, no pack     →  Athena       (scaffold the context pack)
pack, no stories  →  Hestia       (scrum master — breaks into stories)
stories ready     →  Hercules     (dev — implements)
implementation    →  Nemesis      (QA — verifies, files bugs)
verified          →  Iris         (release — ships)
```

Each handoff is explicit. Each agent reads the context pack on entry. Each
turn is logged.

### 4. Tools + Hooks + Skills

Every action — read a file, run a command, fetch a URL, edit code — goes
through a **typed tool** with a Zod schema, an approval mode (`auto` / `ask` /
`never`), and a `whenToUse` contract. Tools run inside **lifecycle hooks**
that can block: dangerous commands get caught (`rm -rf /`,
`git push --force`), secrets get redacted on the way out, vague answers get
bounced back to clarify, prompt-injection markers in fetched content get
flagged.

When a tool needs domain knowledge it doesn't have, the agent loads a
**Skill** (a `SKILL.md` with activation triggers — like loading a manual page
on demand).

### 5. Built-in quality gates, not meetings

Each major artifact (PRD, architecture, story, ship) runs against a built-in
**Checklist** with severity-ranked items. Blockers stop the chain. Warnings
get logged to the progress tracker. The `open_question` tool queues genuine
ambiguities to your tracker so the agent doesn't make up your product spec
mid-flight.

### 6. Atomic commits + auto-tracker

Every successful `git commit` automatically gets a one-liner appended to
`context/progress-tracker.md` § Recent Decisions. Future sessions wake up with
the full history of what was decided and shipped, in plain English.

---

## The Pantheon

| Role | God | Domain |
|------|-----|--------|
| Product manager | **Athena** | Strategic wisdom, deliberate planning |
| Architect | **Prometheus** | Forethought, system design |
| Scrum master | **Hestia** | Hearth-keeper, bringer of order |
| Developer | **Hercules** | The Twelve Labors — relentless execution |
| QA | **Nemesis** | Retribution against hubris (bugs) |
| UX | **Aphrodite** | Beauty, aesthetics, feel |
| Release | **Iris** | Messenger between realms (dev → prod) |
| Docs / analyst | **Apollo** | Truth, prophecy, research |
| Coordinator | **Hermes** | Multi-agent traffic |
| Orchestrator | **Atlas** | Holds the world up so you don't have to |

Each agent ships with its own persona DNA (voice, activation triggers,
boundaries, examples), allowed tool list, owned templates, and required
checklists. They are not interchangeable.

---

## Why It Works

### Six-File Context Pack
Every agent reads the same compact pack (`project-overview` /
`code-standards` / `ai-workflow-rules` / `progress-tracker`) at the top of
every system prompt. With Anthropic's prompt caching, the pack is essentially
free after the first call. Models stop hallucinating your tech stack.

### Typed everything
Tool inputs and outputs are Zod-validated at the boundary. Provider responses
are validated. Config is validated. There is no `any` in the codebase that
isn't justified in a comment. When something breaks, you get a structured
`Result<T, E>` — not an exception that nukes the loop.

### Hooks are real
Hooks block. `dangerousCommand`, `pathSafety`, `secretRedaction`,
`promptInjection`, `discoverGuardrails`, `progressTracker` — all typed events
with `'allow' | 'modify' | 'block'` returns. They run before the model ever
sees the result of a tool call.

### Cancellation everywhere
Every async path threads an `AbortSignal`. Hit `Ctrl-C` and the inflight
request, the inflight tool, the inflight subprocess all wind down cleanly.

### Atomic commits + plain-English history
Each task gets its own commit. `git log` reads like a changelog. The
progress-tracker hook keeps a running ledger so the next session has memory.

---

## What Ships in v0.1.0

- ✅ Foundation: monorepo, build, tests, `atlas doctor`, `atlas --version`
- ✅ Streaming chat (`atlas ask`) against any provider
- ✅ Interactive Ink TUI REPL (`atlas chat`) with slash-commands
- ✅ Tool system with approval modes
- ✅ Hook system (typed pre/post lifecycle events)
- ✅ Skills system (Hermes-style on-demand `SKILL.md`)
- ✅ MCP client (stdio transport)
- ✅ Greek-pantheon agents with personas, handoffs, ownership
- ✅ Orchestrator: project state → recommended agent
- ✅ Context window manager (auto-compact at 80%)
- ✅ Persistent sessions
- ✅ Templates engine + 20 starter templates (Handlebars + Zod)
- ✅ Checklists engine + 18 starter checklists
- ✅ Workflow chains + handoff-aware routing
- ✅ Six-File Context Pack with auto-tracker hook
- ✅ Sectioned long-form templates (per-section render/write)
- ✅ Project state file + customization overlays

See [`examples/sdd-walkthrough.md`](./examples/sdd-walkthrough.md) for an
end-to-end run: brief → PRD → architecture → UX → design system → epics →
story → implementation → QA.

---

## Configuration

Atlas resolves config in this order (later wins):

1. Built-in defaults
2. `~/.atlas/config.yaml`
3. `<cwd>/.atlas/config.yaml`
4. Environment variables (`OPENROUTER_API_KEY`, etc.)
5. Per-call CLI flags

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full schema.

---

## Development Install

Clone and build locally:

```bash
git clone https://github.com/lucapohl-angel/atlas_CLI.git
cd atlas_CLI
pnpm install
pnpm --filter @atlas/core build
pnpm --filter atlas-os build
node packages/cli/dist/bin/atlas.js doctor
```

Run the full quality gate before any change is "done":

```bash
pnpm --filter @atlas/core build && \
pnpm --filter @atlas/core test:run && \
pnpm --filter atlas-os typecheck && \
pnpm --filter atlas-os test:run && \
pnpm --filter atlas-os build
```

See [`AGENTS.md`](./AGENTS.md) for guidance to AI agents working on this
repository, [`ARCHITECTURE.md`](./ARCHITECTURE.md) for design, and
[`context/`](./context/) for the lived-in context pack.

---

## License

[MIT](./LICENSE).

---

<div align="center">

**Atlas·OS — your engineering crew lives in the terminal now.**

</div>
