<div align="center">

# ATLAS·OS

**Autonomous Teams · Lifecycle · Agents · Skills — Orchestration System**

A multi-agent, hook-driven, model-agnostic engineering OS for the terminal.
Hand it a vague idea. Get back a planned, built, tested, committed feature —
with a Greek pantheon of specialist agents doing the work.

[![npm version](https://img.shields.io/npm/v/atlas-os?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/atlas-os)
[![GitHub stars](https://img.shields.io/github/stars/lucapohl-angel/ATLAS_OS?style=for-the-badge&logo=github&color=181717)](https://github.com/lucapohl-angel/ATLAS_OS)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

<br>

```bash
npx atlas-os@latest
```

**Works on macOS, Linux, and Windows through WSL2. Bring Anthropic, OpenAI, or OpenRouter.**

<br>

![Atlas·OS terminal](assets/atlasOS_TERMINAL.png)

<br>

[Why I Built This](#why-i-built-this) ·
[How It Compares](#how-it-compares) ·
[Install](#install) ·
[How It Works](#how-it-works) ·
[Dev](#dev)

</div>

---

## Why I Built This

Atlas exists because most AI coding CLIs are either:

- a single chatbot that loses project shape after a few prompts, or
- a process you have to assemble yourself before it can help you ship.

ATLAS·OS keeps the flow simple (`atlas`, describe the goal, ship) while keeping
the engine serious: multi-agent orchestration, typed tools, hook-based safety,
and persistent project state.

---

## How It Compares

| Capability | **ATLAS·OS** | Claude Code | OpenCode | Gemini CLI | Kilo Code |
|---|---|---|---|---|---|
| Provider choice | Anthropic · OpenAI · OpenRouter | Claude-focused | Provider-agnostic | Gemini-focused | Kilo router |
| Multi-agent orchestration | Built-in Greek pantheon, routed by project state | Agent teams + subagents | Build / Plan + subagent | Subagents | Modes |
| Spec-driven pipeline | Built-in PRD -> architecture -> stories -> implementation -> QA -> release | Bring your own | Bring your own | Bring your own | Bring your own |
| Lifecycle hooks | Typed TypeScript hooks around tools/messages | Hook system | Plugins / MCP | Hooks | Plugins / MCP |
| Agent skills | Built-in skill loader + learned skills | Skills | Skills | Skills | Skills |
| MCP servers | Built in: stdio + Streamable HTTP, configured from the TUI | Built in | Built in | Built in | Built in |
| Terminal-first | `atlas` opens the full-screen TUI | Terminal | Terminal | Terminal | VS Code-first, CLI available |
| License | MIT | Proprietary | MIT | Apache-2.0 | MIT |

Atlas's edge is not one isolated feature. It is the SDD pipeline, specialist
agents, typed hooks/tools, MCP integration, and release workflow shipped as one
terminal system.

---

## Install

### macOS

```bash
npx atlas-os@latest

# Or install globally
npm install -g atlas-os
atlas
```

### Linux

```bash
npx atlas-os@latest

# Or install globally
npm install -g atlas-os
atlas
```

### Windows

WSL2 is recommended for the full Atlas experience.

```powershell
# In an elevated PowerShell, one time:
wsl --install -d Ubuntu
```

Then inside Ubuntu:

```bash
sudo apt update && sudo apt install -y nodejs npm
npm install -g atlas-os
atlas
```

Native Windows can run the core CLI, but the shell tool expects POSIX commands.
Use WSL2 if you want tool execution to match Linux/macOS behavior.

### What Gets Installed

The package installs a small dispatcher plus the native binary for your platform.
Other platform binaries are optional dependencies and are skipped automatically.
If the native binary is unavailable, Atlas falls back to the bundled JS build on
Node.js 20+.

### VS Code Setup

The VS Code integrated terminal catches shortcuts like `Ctrl+P` before terminal
apps can see them. Run this once if you use Atlas inside VS Code:

```bash
atlas vscode-setup
# then reload VS Code
```

Use `--dry-run` to preview the settings change, or `--path <file>` for a
non-default VS Code settings file.

### Providers

The easiest path is inside the TUI:

```bash
atlas
```

Then open `/config`, choose a provider, and paste the key. Atlas stores it in
`~/.atlas/config.yaml`.

Environment variables also work:

```bash
export OPENROUTER_API_KEY=sk-or-...     # broad hosted-model catalog
export ANTHROPIC_API_KEY=sk-ant-...     # Anthropic direct
export OPENAI_API_KEY=sk-...            # OpenAI / ChatGPT direct
```

Optional config:

```yaml
defaultProvider: openrouter
defaultModel: anthropic/claude-sonnet-4.5
providers:
  openrouter:
    apiKey: sk-or-...
```

### Project Bootstrap

Run this once per machine or project workspace:

```bash
atlas init
```

Then open Atlas:

```bash
atlas
```

New launches start on a fresh splash. Use `/sessions` or `/resume <id>` when you
want to manually reopen an older transcript.

---

## How It Works

### Greenfield

Use Atlas when you have an idea but no project shape yet.

1. Run `atlas init`.
2. Start `atlas`.
3. Describe the product or feature.
4. Atlas routes through planning, architecture, stories, implementation, QA,
   and release.

Typical flow:

```text
idea only         -> Athena      (PM: clarify and write the PRD)
PRD ready         -> Prometheus  (architect: lock design and constraints)
stories needed    -> Hestia      (scrum master: split into buildable work)
story ready       -> Hercules    (dev: implement)
implementation    -> Nemesis     (QA: verify and file issues)
verified          -> Iris        (release: package and ship)
```

### Brownfield

Use Atlas inside an existing repo when you want it to understand what is already
there before changing code.

1. Open the repo.
2. Run `atlas init` if the built-in agents/skills are not installed yet.
3. Start `atlas`.
4. Use `/onboard` to map the codebase, reuse existing docs when available, and
   generate or update onboarding artifacts.
5. Ask for the change you want. Atlas should inspect the repo, plan narrowly,
   edit, then run the repo's own verification gates.

Sessions are saved, but Atlas does not auto-open the last one. Reopen old work
from `/sessions` when you need it.

---

## Dev

Requirements:

- Node.js 20+
- pnpm 10.33.2 (`npm install -g pnpm@10.33.2`, or Corepack if your Node install provides it)

Local build:

```bash
git clone https://github.com/lucapohl-angel/ATLAS_OS.git
cd ATLAS_OS
pnpm install
pnpm --filter @atlas/core build
pnpm --filter atlas-os build
node packages/cli/dist/bin/atlas.js doctor
```

Full quality gate:

```bash
pnpm --filter @atlas/core build && \
pnpm --filter @atlas/core test:run && \
pnpm --filter atlas-os typecheck && \
pnpm --filter atlas-os test:run && \
pnpm --filter atlas-os build && \
pnpm lint
```

Experienced-user tweaks:

- Providers: edit `~/.atlas/config.yaml`, set provider env vars, or use
  `/config` in the TUI.
- MCP servers: use `/mcps` and `/mcps add` in the TUI, or edit
  `~/.atlas/config.yaml` under `mcp.servers`.
- Agents: add user agents under `~/.atlas/agents/<name>/AGENT.md`; project
  overrides can live in `<repo>/.atlas/agents/`.
- Skills: add skills under `~/.atlas/skills/<name>/SKILL.md`; use `/skills`
  to inspect or toggle them.
- Models: use `/model`, `/config`, or `defaultModel` / `fallbackModels` in
  `~/.atlas/config.yaml`.
- Sessions: use `/sessions` to resume, rename, or delete saved transcripts.

---

## License

[MIT](./LICENSE).

---

<div align="center">

**Atlas·OS — your engineering crew lives in the terminal now.**

</div>
