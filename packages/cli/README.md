<div align="center">

# ATLAS·OS

**Autonomous Teams · Lifecycle · Agents · Skills — Orchestration System**

A multi-agent, hook-driven, model-agnostic engineering OS for the terminal.
Hand it a vague idea. Get back a planned, built, tested, committed feature —
with a Greek pantheon of specialist agents doing the work.

[![npm version](https://img.shields.io/npm/v/atlas-os?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/atlas-os)
[![npm downloads](https://img.shields.io/npm/dm/atlas-os?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/atlas-os)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](https://github.com/lucapohl-angel/atlas_CLI/blob/main/LICENSE)

</div>

```bash
npx atlas-os@latest chat
```

**Works on Mac, Windows, and Linux. Bring any model — Claude, GPT, Gemini, local Ollama, OpenRouter.**

---

## Install

```bash
# One-shot
npx atlas-os@latest chat

# Or global
npm install -g atlas-os
atlas chat
```

Set a key for your provider of choice:

```bash
export OPENROUTER_API_KEY=sk-or-...     # default — gives you every model
export ANTHROPIC_API_KEY=sk-ant-...     # Claude direct
export OPENAI_API_KEY=sk-...            # GPT direct
export GOOGLE_API_KEY=...               # Gemini direct
```

Bootstrap your project:

```bash
atlas init       # install built-in agents, skills, templates, checklists
atlas status     # the orchestrator tells you what to do next
atlas chat       # drop into the REPL
```

---

## What it does

Atlas runs a spec-driven delivery pipeline with a Greek pantheon of specialist
sub-agents (Athena, Prometheus, Hestia, Hercules, Nemesis, Aphrodite, Iris,
Apollo, Hermes, Atlas). The orchestrator picks the next agent based on what
your project has — PRD, architecture, context pack, stories, code — and hands
off explicitly between phases.

Behind the REPL: typed Zod-validated tool contracts, blocking lifecycle hooks
(`dangerousCommand`, `pathSafety`, `secretRedaction`, `promptInjection`,
`progressTracker`), on-demand skill loading, MCP client, persistent sessions,
context-window auto-compact, and a six-file Context Pack auto-injected at the
prompt prefix (cache-friendly with Anthropic).

Model-agnostic on purpose. Atlas does not assume Claude. The same crew runs
against OpenRouter, OpenAI, Anthropic, Google, or local Ollama with one
config line.

---

## Why it's different

| | **Atlas·OS** | Single-agent CLIs |
|---|---|---|
| Multi-agent, role-typed | ✅ | ❌ |
| Spec-driven pipeline (PRD→arch→stories→impl→QA→ship) | ✅ | ❌ |
| Typed tool contracts + approval modes | ✅ | ⚠️ |
| Blocking lifecycle hooks | ✅ | ❌ |
| Six-file context pack auto-injected | ✅ | ❌ |
| Model-agnostic (any provider) | ✅ | ⚠️ |
| Atomic commits + auto-tracker hook | ✅ | ❌ |

---

## Docs

- [Full README, walkthrough, architecture](https://github.com/lucapohl-angel/atlas_CLI)
- [End-to-end SDD walkthrough](https://github.com/lucapohl-angel/atlas_CLI/blob/main/examples/sdd-walkthrough.md)
- [Architecture & invariants](https://github.com/lucapohl-angel/atlas_CLI/blob/main/ARCHITECTURE.md)

---

## License

[MIT](https://github.com/lucapohl-angel/atlas_CLI/blob/main/LICENSE)
