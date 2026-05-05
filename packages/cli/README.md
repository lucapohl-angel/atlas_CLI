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

**Works on macOS, Linux, and Windows through WSL2. Bring Anthropic, OpenAI, or OpenRouter.**

![Atlas·OS terminal](https://raw.githubusercontent.com/lucapohl-angel/ATLAS_OS/main/assets/atlas-os-splash.png)

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
