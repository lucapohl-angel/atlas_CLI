# SDD Walkthrough — Brief → Production with Atlas

> A complete end-to-end run of the Greek-god pipeline on a fictional product.
> Every transition shown here is driven by the built-in agents, templates,
> checklists, and workflow chains that ship with `atlas init`. No custom
> agents, no manual routing.

We will build **Lumen**, a "focus timer + journal" desktop app, from a
two-sentence idea to a green QA gate.

---

## 0. Prerequisites

```bash
pnpm install
pnpm build
node packages/cli/dist/bin/atlas.js doctor   # sanity check
node packages/cli/dist/bin/atlas.js init     # write ~/.atlas/{agents,skills,templates,checklists,workflows}
```

After `init`, your home directory contains:

```
~/.atlas/
├── agents/
│   ├── athena/         AGENT.md (PM)
│   ├── prometheus/     AGENT.md (Architect)
│   ├── aphrodite/      AGENT.md (UX + design system)
│   ├── hermes/         AGENT.md (Epic breakdown)
│   ├── hestia/         AGENT.md (Scrum Master)
│   ├── hercules/       AGENT.md (Developer)
│   ├── nemesis/        AGENT.md (QA)
│   ├── iris/           AGENT.md (DevOps / release)
│   └── apollo/         AGENT.md (Analyst / docs)
├── templates/          16 YAML templates
├── checklists/         17 YAML checklists
└── workflows/
    └── chains.yaml     Built-in routing table
```

---

## 1. Idea → Brief (Athena)

```bash
atlas chat
```

```
> /agent athena
> *write-brief

We want a focus timer that nudges the user to journal at the end of every
session. Privacy-first, local-only data. Ships on macOS first.
```

Athena renders the `product-brief` template, eliciting any missing fields:
problem, audience, success metrics, scope (in/out), risks. The output lands
at `docs/brief.md`. Athena then runs the `product-brief-ready` checklist —
14 items including "problem statement names a specific user", "success
metrics are quantitative", "out-of-scope list is explicit" — and reports
`verdict: pass`.

```
✓ docs/brief.md written
✓ product-brief-ready: 14 pass / 0 fail (verdict: pass)
recommended next: athena (write-prd)
  source: chain
  reason: brief approved; draft the PRD next
```

The chain table fired (`fromAgent: athena, command: write-brief →
toAgent: athena, nextCommand: write-prd`). No manual switching.

---

## 2. Brief → PRD (Athena)

```
> *write-prd
```

Athena loads the brief as elicited input, then walks the `prd` template:
goals, personas, user journeys, functional requirements, non-functional
requirements, milestones, open questions. The PRD lands at `docs/prd.md`
and the `prd-ready` checklist runs (16 items).

```
recommended next: prometheus (write-architecture)
  source: chain
  reason: PRD ready; hand to architect
```

Atlas's orchestrator detected the `docs/prd.md` artifact (project state:
`hasPRD = true`) — but the chain table was authoritative.

---

## 3. PRD → Architecture (Prometheus)

```
> /agent prometheus
> *write-architecture
```

Prometheus's persona DNA includes `voiceDna: ["forethought-first",
"name the failure modes before the happy path", …]` and
`capabilityBoundaries: ["never edit acceptance criteria", "never write
implementation code"]`. He renders the `architecture` template with
sections for: system context, decomposition, data flow, persistence,
security model, observability, and three ADRs.

The `architecture-ready` checklist runs (15 items including "every NFR
in the PRD has a section that addresses it" and "at least one ADR
records a *rejected* alternative with the reason").

```
recommended next: aphrodite (write-ux-spec)
  source: chain
```

---

## 4. Architecture → UX → Design System (Aphrodite)

```
> /agent aphrodite
> *write-ux-spec
```

Aphrodite renders the `ux-spec` template (key flows, states, empty/error
edges, accessibility notes). Then:

```
> *design-system
```

This invokes the `design-system` template, which is special: it has a
`preamble:` field (block scalar `|+`) so the rendered file starts with
`---` at byte 0 — required by the
[`google-labs-code/design.md`](https://github.com/google-labs-code/design.md)
v0.1.0 spec.

After the file lands, Aphrodite's persona body instructs her to run:

```bash
npx @google/design.md lint DESIGN.md
```

Atlas declares `npm >= 10` as an engine requirement so this is always
available. Any `error` finding is a blocker; warnings become checklist
warnings.

The `design-system-ready` checklist runs (12 items including
"unique-headings", "every color is unescaped hex", "section order
matches the canonical spec").

```
recommended next: hermes (write-epics)
  source: chain
```

---

## 5. Design System → Epics (Hermes)

```
> /agent hermes
> *write-epics
```

Hermes loads PRD + architecture and produces `docs/epics.md` — a list of
4–8 epics, each with a one-sentence goal, user value, and rough
sequencing. The `epics-ready` checklist verifies coverage (every PRD
goal maps to ≥1 epic), independence (no circular dependencies), and
sizing (each epic is 1–3 stories).

```
recommended next: hestia (write-story)
  source: chain
  reason: epics ready; SM converts the next epic to a story
```

---

## 6. Epics → Story (Hestia)

```
> /agent hestia
> *write-story
```

Hestia (Scrum Master) picks the first epic and renders the `story`
template into `docs/stories/1-1-focus-timer-loop.md`:

```yaml
status: ready-for-dev
acceptance_criteria:
  - GIVEN a 25-minute timer is running, WHEN the user clicks pause,
    THEN the elapsed time is preserved and resume continues from there.
  - …
implementation_notes: ""    # ← Hestia is forbidden from this section
```

This is where **mixed-mode authorization** kicks in. Hestia's
`authorizedSections` includes `acceptance_criteria` but not
`implementation_notes`. If she tries to write the latter, the
`story_update` tool refuses at the boundary.

```
recommended next: hercules (implement)
  source: chain
```

---

## 7. Story → Implementation (Hercules)

```
> /agent hercules
> *implement
```

Hercules is in `mode: build` — full tool access subject to per-tool
approval. He reads the story, plans tasks, edits files via `write_file`
and `terminal`, and updates the `implementation_notes` and `file_list`
sections of the story file (his authorized sections; he is *forbidden*
from touching `acceptance_criteria`).

When done, he flips `status: review` and the story handoff lands in
the queue.

```
recommended next: nemesis (qa-review)
  source: handoff      ← handoff queue beat the chain table
  reason: story 1-1-focus-timer-loop ready for review
```

The handoff queue *won* over the chain entry (`hercules implement →
nemesis qa-review`) because both pointed at the same place; if Hercules
had instead handed off to Iris for an emergency hotfix, the handoff
file would have routed there regardless of the chain.

---

## 8. Implementation → QA (Nemesis)

```
> /agent nemesis
> *qa-review
```

Nemesis runs the `definition-of-done` cross-cutting checklist (8 items:
all ACs satisfied, tests green, no regression, file list complete,
docstrings updated, security checklist clean, etc.) and the
`security-review` checklist (10 items: input validation at boundaries,
no secrets in code, no shell injection, etc.).

If `verdict: pass`, she flips story status to `done` and:

```
recommended next: hestia (write-story)
  source: chain
  reason: story passed QA; back to SM for the next slice
```

The loop continues epic by epic.

---

## 9. Release (Hercules → Iris → Apollo)

When all stories under an epic are `done`:

```
> /agent hercules
> *release-prep

→ recommended next: iris (write-release-notes)
  source: chain

> /agent iris
> *write-release-notes

→ recommended next: apollo (write-handover-doc)
  source: chain
  reason: release shipped; produce the handover/changelog narrative
```

Apollo (Analyst) writes the customer-facing changelog and any retro
docs. Loop closes.

---

## What just happened

Every transition in this walkthrough was driven by **one of three
mechanisms**, in priority order:

1. **Handoff queue** — frontmatter envelopes left by upstream agents
   (`packages/core/src/stories/handoff.ts`). Oldest unconsumed wins.
2. **Chain table** — `~/.atlas/workflows/chains.yaml`. Specific
   `(fromAgent, command)` match beats wildcard.
3. **State fallback** — pure function from detected artifacts to a
   recommended agent (`packages/core/src/orchestrator/decide.ts`).

The TUI (and `atlas status --json`) tells you which one fired via the
`source` discriminator.

## Customizing the pipeline

Edit any file under `~/.atlas/`:

- **Routing** → `~/.atlas/workflows/chains.yaml` or, for project-local
  overrides, `<cwd>/.atlas/workflows/chains.yaml` (project wins).
- **Templates** → `~/.atlas/templates/<id>.yaml`. The newest `version`
  field wins on duplicate id.
- **Checklists** → `~/.atlas/checklists/<id>.yaml`. Same dedup rule.
- **Personas** → `~/.atlas/agents/<name>/AGENT.md`. Edit the YAML
  frontmatter and persona body freely.

Phase 11 (queued) will add deep-merge overlays so you can extend
built-ins without copying them — three-tier resolution
(built-in → user `~/.atlas/` → project `<cwd>/.atlas/`) with the
project tier winning.

## Where to look in the code

| What | File |
| ---- | ---- |
| Template engine | `packages/core/src/templates/render.ts` |
| Template loader (newest-wins) | `packages/core/src/templates/loader.ts` |
| Checklist runner | `packages/core/src/checklists/run.ts` |
| Workflow chain matcher | `packages/core/src/workflows/loader.ts` |
| Orchestrator next-pick | `packages/core/src/workflows/recommend.ts` |
| Story section authorization | `packages/core/src/stories/update.ts` |
| Built-in personas (source of truth) | `packages/core/src/builtins/index.ts` |
| Built-in templates / checklists / chains | `packages/core/src/builtins/{templates,checklists,workflows}.ts` |
