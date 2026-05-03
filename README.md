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
npx atlas-os@latest
```

**Works on Mac, Windows, and Linux. Bring any model — Claude, GPT, Gemini, local Ollama, OpenRouter.**

<br>

![Atlas·OS terminal](assets/atlas-os-splash.png)

<br>

[Why I Built This](#why-i-built-this) ·
[How It Compares](#how-it-compares) ·
[How It Works](#how-it-works) ·
[Install](#install) ·
[Walkthrough](./examples/sdd-walkthrough.md)

</div>

---

## Why I Built This

Atlas exists because most AI coding CLIs are either:

- a single chatbot that loses project context after a few prompts, or
- a heavyweight process framework with too much ceremony for small teams.

ATLAS·OS keeps the flow simple (`atlas`, describe the goal, ship) while keeping
the engine serious: multi-agent orchestration, typed tools, hook-based safety,
and a persistent context pack.

---

## How It Compares

| Capability | **ATLAS·OS** | Claude Code | OpenCode | Gemini CLI | Kilo Code |
|---|---|---|---|---|---|
| Multi-provider models | ✅ Anthropic · OpenAI · Google · OpenRouter · Ollama | ❌ Claude only (Anthropic / Bedrock / Vertex) | ✅ Provider-agnostic | ❌ Gemini only | ✅ 500+ via Kilo router |
| Multi-agent orchestration | ✅ Greek pantheon, role-routed by project state | ✅ Agent Teams + subagents | ⚠️ Build / Plan + `@general` subagent | ⚠️ Subagents (experimental) | ⚠️ Modes (Architect / Coder / Debugger) |
| Spec-driven pipeline (PRD → arch → stories → impl → QA → release) | ✅ Built into the orchestrator | ❌ Bring your own | ❌ Bring your own | ❌ Bring your own | ❌ Bring your own |
| Lifecycle hooks (block / modify / allow tool calls) | ✅ Typed TS hooks | ✅ Extensive — shell, HTTP, MCP, prompt, agent | ❌ Plugins / MCP instead | ✅ Hooks supported | ❌ Plugins / MCP instead |
| Agent Skills | ✅ Built-in skill loader | ✅ | ✅ | ✅ | ⚠️ Inherited from OpenCode |
| Project context auto-injected | ✅ Six-file context pack | ⚠️ Single `CLAUDE.md` | ⚠️ Single `AGENTS.md` | ⚠️ Single `GEMINI.md` | ⚠️ Single `AGENTS.md` |
| MCP servers | ⚠️ Planned | ✅ | ✅ | ✅ | ✅ |
| Terminal-first | ✅ `atlas` opens TUI | ✅ | ✅ | ✅ | ⚠️ VS Code extension first; CLI added later |
| License | ✅ MIT | ❌ Proprietary | ✅ MIT | ✅ Apache-2.0 | ✅ MIT |

> Verified against each tool's public docs. Atlas's edge isn't any single
> feature — it's the opinionated **SDD pipeline + six-file context pack +
> typed TS hooks/tools** shipped in one package. The other tools each do parts
> of this well; none ship the whole loop out of the box.

---

## Install

```bash
# One-shot (latest)
npx atlas-os@latest

# Or install globally
npm install -g atlas-os
atlas
```

### Compatibility

| OS | Status | Notes |
|---|---|---|
| Linux | ✅ Tested | Arch / Garuda, Ubuntu, Fedora |
| macOS (Intel + Apple Silicon) | ✅ Supported | Same Node 20+ POSIX runtime |
| Windows + WSL2 | ✅ Recommended for Windows users | Identical experience to Linux |
| Windows native (PowerShell / cmd) | ⚠️ Partial | Shell tool assumes POSIX; SearXNG (Docker) unavailable |

Requirements: **Node.js 20+** and a terminal that supports the alt-screen TUI
(Windows Terminal, iTerm2, WezTerm, Ghostty, Kitty, Alacritty all work).

### Windows setup (WSL2 — recommended)

```powershell
# In an elevated PowerShell, one-time:
wsl --install -d Ubuntu
```

Then inside the new Ubuntu shell:

```bash
sudo apt update && sudo apt install -y nodejs npm
npm install -g atlas-os
atlas
```

Native Windows works for the core REPL, but the built-in shell tool runs POSIX
commands and the optional SearXNG web-search needs Docker. Use WSL2 for full
fidelity.

### VS Code setup

The VS Code integrated terminal swallows shortcuts like `Ctrl+P` before the
TUI sees them. Fix it in one command:

```bash
atlas vscode-setup        # patches your VS Code settings.json
# then reload VS Code
```

The patcher writes:

- `terminal.integrated.sendKeybindingsToShell: true`
- `commandsToSkipShell` overrides so `Ctrl+P`, `Ctrl+Shift+P`, `Ctrl+B`,
  `Ctrl+J`, `Ctrl+W`, ``Ctrl+` `` reach Atlas instead of VS Code

Use `--dry-run` to preview, or `--path <file>` for a non-default install
location. Same constraint applies to Claude Code and OpenCode in the VS Code
terminal — Atlas just ships a one-liner.

Set one provider key:

```bash
export OPENROUTER_API_KEY=sk-or-...     # default — gives you every model
export ANTHROPIC_API_KEY=sk-ant-...     # Claude direct
export OPENAI_API_KEY=sk-...            # GPT direct
export GOOGLE_API_KEY=...               # Gemini direct
```

Optional config (`~/.atlas/config.yaml`):

```yaml
defaultProvider: openrouter
defaultModel: anthropic/claude-sonnet-4.5
providers:
  openrouter:
    apiKey: sk-or-...
```

Bootstrap:

```bash
atlas init       # install built-in agents, skills, templates, checklists
atlas status     # the orchestrator tells you what to do next
atlas            # open the TUI
```

---

## How It Works

1. Run `atlas init` once in a project.
2. Launch with `atlas` and describe the goal.
3. The orchestrator routes work by project state:

```
no PRD            →  Athena       (PM — writes PRD)
PRD only          →  Prometheus   (architect — locks design)
arch, no pack     →  Athena       (scaffold the context pack)
pack, no stories  →  Hestia       (scrum master — breaks into stories)
stories ready     →  Hercules     (dev — implements)
implementation    →  Nemesis      (QA — verifies, files bugs)
verified          →  Iris         (release — ships)
```
4. Agents use typed tools, lifecycle hooks, and checklists to keep quality and
safety high while still moving fast.

See [examples/sdd-walkthrough.md](./examples/sdd-walkthrough.md) for a full run.

---

## Dev

Local build:

```bash
git clone https://github.com/lucapohl-angel/atlas_CLI.git
cd atlas_CLI
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
pnpm --filter atlas-os build
```

More detail: [ARCHITECTURE.md](./ARCHITECTURE.md), [AGENTS.md](./AGENTS.md), [context/](./context/)

---

## License

[MIT](./LICENSE).

---

<div align="center">

**Atlas·OS — your engineering crew lives in the terminal now.**

</div>
