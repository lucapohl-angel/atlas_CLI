<div align="center">

# ATLAS·OS

**Autonomous Teams · Lifecycle · Agents · Skills — Orchestration System**

A multi-agent, hook-driven, model-agnostic engineering OS for the terminal.
Hand it a vague idea. Get back a planned, built, tested, committed feature —
with a Greek pantheon of specialist agents doing the work.

[![npm version](https://img.shields.io/npm/v/atlas-os?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/atlas-os)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](https://github.com/lucapohl-angel/ATLAS_OS/blob/main/LICENSE)

</div>

```bash
npx atlas-os@latest
```

**Works on macOS, Linux, and Windows through WSL2. Bring Anthropic, OpenAI, OpenRouter, or local models.**

![Atlas·OS terminal](https://raw.githubusercontent.com/lucapohl-angel/ATLAS_OS/main/assets/atlasOS_TERMINAL.png)

---

## Install

### macOS / Linux

```bash
npx atlas-os@latest

# Or install globally
npm install -g atlas-os
atlas
```

### Windows

WSL2 is recommended:

```powershell
wsl --install -d Ubuntu
```

Then inside Ubuntu:

```bash
sudo apt update && sudo apt install -y nodejs npm
npm install -g atlas-os
atlas
```

Native Windows can run the core CLI, but the shell tool expects POSIX commands.

### VS Code

```bash
atlas vscode-setup
# then reload VS Code
```

Use `--dry-run` to preview the settings change.

### Providers

Open the TUI and use `/config` to add a provider key:

```bash
atlas
```

Environment variables also work:

```bash
export OPENROUTER_API_KEY=sk-or-...
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
```

Hosted model cost posture is configurable from `/config -> Atlas power mode`.

| Mode | Cost Estimate | Pros | Cons |
|---|---|---|---|
| Atlas Power Full | roughly 100k-250k input tokens on heavy turns before cache; cache-capable models make repeat turns cheaper | maximum Atlas context, tools, MCP, hooks, and predictable behavior | no-cache models rebill the full prefix each message |
| Atlas Smart Mode | roughly 20k-80k input tokens on normal hosted turns; complex turns can still pay Full Atlas costs | cost-aware default for daily hosted work | very complex work may still need the full prompt/tool surface |

The active hosted mode is visible in the TUI top bar as `ATLAS POWER` in bright
red or `ATLAS SMART` in bright green.

The model picker writes cache support beside provider-pulled models as
`cache yes`, `cache unknown`, or `cache no` so cheaper cache-capable models are
easy to spot. OpenRouter rows use the live `/models` cache-pricing fields, and
`/models` includes a search field for filtering long provider catalogs.

Saved sessions are managed from `/sessions`: resume, rename, start fresh,
delete one, select several for deletion, or delete all with confirmation.

Local models work through Ollama, LM Studio, vLLM, or any local
OpenAI-compatible `/v1` server. Atlas auto-detects Ollama at
`http://localhost:11434/v1`; use `/config -> Local models` to choose Lite,
Hybrid, or Full Atlas mode.

```bash
ollama pull qwen2.5-coder:1.5b
ollama pull qwen2.5-coder:7b
```

| Mode | Requirements | Best For | Tradeoff |
|---|---|---|---|
| Lite | CPU ok, 4-8 GB RAM, 1.5B-7B models | quick local chat | no model-driven tools |
| Hybrid | 8-12 GB VRAM or strong CPU, 7B-14B models | local coding with core dev tools | limited tool set |
| Full Atlas | 24 GB+ VRAM or hosted server, 30B-70B+ models | full Atlas prompt, tools, MCP, and hooks | largest payload |

Bootstrap once:

```bash
atlas init
```

New launches start fresh. Use `/sessions` or `/resume <id>` to reopen old
transcripts manually.

---

## What It Does

ATLAS·OS is a multi-agent, spec-driven coding system for the terminal. You
describe the goal; the orchestrator routes work across specialist agents for
planning, architecture, implementation, QA, and release.

Under the hood: typed tool contracts, lifecycle hook guardrails, skills,
checklists, MCP support, sessions, and provider/model routing.

---

## Why It Is Different

| Capability | **ATLAS·OS** | Claude Code | OpenCode | Gemini CLI | Kilo Code |
|---|---|---|---|---|---|
| Provider choice | Anthropic · OpenAI · OpenRouter | Claude-focused | Provider-agnostic | Gemini-focused | Kilo router |
| Multi-agent orchestration | Built-in Greek pantheon | Agent teams + subagents | Build / Plan + subagent | Subagents | Modes |
| Spec-driven pipeline | Built in | Bring your own | Bring your own | Bring your own | Bring your own |
| Lifecycle hooks | Typed TypeScript hooks | Hook system | Plugins / MCP | Hooks | Plugins / MCP |
| MCP servers | Built in | Built in | Built in | Built in | Built in |
| Terminal-first | Full-screen TUI | Terminal | Terminal | Terminal | VS Code-first |
| License | MIT | Proprietary | MIT | Apache-2.0 | MIT |

Atlas's edge is the SDD pipeline, specialist agents, typed hooks/tools, MCP
integration, and release workflow shipped as one terminal system.

---

## Docs

- [Full README, walkthrough, architecture](https://github.com/lucapohl-angel/ATLAS_OS)
- [End-to-end SDD walkthrough](https://github.com/lucapohl-angel/ATLAS_OS/blob/main/examples/sdd-walkthrough.md)
- [Architecture & invariants](https://github.com/lucapohl-angel/ATLAS_OS/blob/main/ARCHITECTURE.md)

---

## License

[MIT](https://github.com/lucapohl-angel/ATLAS_OS/blob/main/LICENSE)
