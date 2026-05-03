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
npx atlas-os@latest
```

**Works on Mac, Windows, and Linux. Bring any model — Claude, GPT, Gemini, local Ollama, OpenRouter.**

![Atlas·OS terminal](https://raw.githubusercontent.com/lucapohl-angel/atlas_CLI/main/assets/atlas-os-splash.png)

---

## Install

```bash
# One-shot
npx atlas-os@latest

# Or global
npm install -g atlas-os
atlas
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
atlas            # open the TUI
```

---

## What it does

ATLAS·OS is a multi-agent, spec-driven coding system for the terminal.
You describe the goal; the orchestrator routes work across specialist agents
for planning, architecture, implementation, QA, and release.

Under the hood: typed tool contracts, lifecycle hook guardrails, on-demand
skills, checklists, MCP support, and a six-file context pack shared by agents.

---

## Why it's different

| Capability | **ATLAS·OS** | Claude CLI | OpenCode CLI | Gemini CLI | Cursor Agent |
|---|---|---|---|---|---|
| Model choice | ✅ Anthropic, OpenAI, Google, OpenRouter, Ollama | ❌ Claude-focused | ⚠️ Varies | ❌ Gemini-focused | ⚠️ Mostly Claude/GPT |
| Multi-agent orchestration | ✅ Built in | ❌ | ❌ | ❌ | ⚠️ Limited |
| Spec-driven pipeline (PRD→arch→stories→impl→QA) | ✅ Built in | ❌ | ❌ | ❌ | ❌ |
| Hook guardrails (block/modify/allow) | ✅ Typed lifecycle hooks | ❌ | ❌ | ❌ | ❌ |
| Project context pack auto-injected | ✅ Six-file pack | ❌ | ❌ | ❌ | ❌ |
| Terminal-first default | ✅ `atlas` opens TUI | ✅ | ✅ | ✅ | ❌ Editor-first |

---

## Docs

- [Full README, walkthrough, architecture](https://github.com/lucapohl-angel/atlas_CLI)
- [End-to-end SDD walkthrough](https://github.com/lucapohl-angel/atlas_CLI/blob/main/examples/sdd-walkthrough.md)
- [Architecture & invariants](https://github.com/lucapohl-angel/atlas_CLI/blob/main/ARCHITECTURE.md)

---

## License

[MIT](https://github.com/lucapohl-angel/atlas_CLI/blob/main/LICENSE)
