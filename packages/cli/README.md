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

### Compatibility

| OS | Status |
|---|---|
| Linux | ✅ Tested (Arch, Ubuntu) |
| macOS (Intel + Apple Silicon) | ✅ Supported |
| Windows + WSL2 | ✅ Recommended for Windows users |
| Windows native (PowerShell / cmd) | ⚠️ Partial — shell tool assumes POSIX |

Requirements: **Node 20+**.

### Windows (WSL2)

```powershell
wsl --install -d Ubuntu
```

```bash
sudo apt update && sudo apt install -y nodejs npm
npm install -g atlas-os
atlas
```

### VS Code

The integrated terminal eats shortcuts like `Ctrl+P`. Free them in one command:

```bash
atlas vscode-setup        # patches your VS Code settings.json
# then reload VS Code
```

Use `--dry-run` to preview. Same constraint applies to Claude Code / OpenCode
in the VS Code terminal — Atlas just ships the one-liner.

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

| Capability | **ATLAS·OS** | Claude Code | OpenCode | Gemini CLI | Kilo Code |
|---|---|---|---|---|---|
| Multi-provider models | ✅ Anthropic · OpenAI · Google · OpenRouter · Ollama | ❌ Claude only | ✅ Provider-agnostic | ❌ Gemini only | ✅ 500+ via Kilo router |
| Multi-agent orchestration | ✅ Greek pantheon, role-routed | ✅ Agent Teams + subagents | ⚠️ Build / Plan + `@general` | ⚠️ Subagents (experimental) | ⚠️ Modes (Architect/Coder/Debug) |
| Spec-driven pipeline (PRD→arch→stories→impl→QA) | ✅ Built into orchestrator | ❌ | ❌ | ❌ | ❌ |
| Lifecycle hooks (block/modify/allow tool calls) | ✅ Typed TS hooks | ✅ Extensive | ❌ Plugins / MCP | ✅ | ❌ Plugins / MCP |
| Agent Skills | ✅ | ✅ | ✅ | ✅ | ⚠️ Inherited from OpenCode |
| Project context auto-injected | ✅ Six-file context pack | ⚠️ `CLAUDE.md` | ⚠️ `AGENTS.md` | ⚠️ `GEMINI.md` | ⚠️ `AGENTS.md` |
| MCP servers | ⚠️ Planned | ✅ | ✅ | ✅ | ✅ |
| Terminal-first | ✅ | ✅ | ✅ | ✅ | ⚠️ VS Code-first |
| License | ✅ MIT | ❌ Proprietary | ✅ MIT | ✅ Apache-2.0 | ✅ MIT |

> Atlas's edge isn't any single feature — it's the opinionated **SDD pipeline
> + six-file context pack + typed TS hooks/tools** in one package.

---

## Docs

- [Full README, walkthrough, architecture](https://github.com/lucapohl-angel/atlas_CLI)
- [End-to-end SDD walkthrough](https://github.com/lucapohl-angel/atlas_CLI/blob/main/examples/sdd-walkthrough.md)
- [Architecture & invariants](https://github.com/lucapohl-angel/atlas_CLI/blob/main/ARCHITECTURE.md)

---

## License

[MIT](https://github.com/lucapohl-angel/atlas_CLI/blob/main/LICENSE)
