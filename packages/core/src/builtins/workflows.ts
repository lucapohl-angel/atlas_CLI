/**
 * Default workflow chains baked into the binary. Installed by
 * `atlas init` to `~/.atlas/workflows/chains.yaml` so users can edit
 * the routing without touching code. Mirrors the canonical Greek-god
 * pipeline: idea → PRD → architecture → UX → design system → epics →
 * stories → implementation → QA → release/docs.
 */
import type { BuiltinFile } from './index.js';

const CHAINS_YAML = `# Atlas built-in workflow chains.
# Each entry routes (fromAgent, command?) to the next agent. A specific
# command match wins over a wildcard (no command) entry. Edit freely:
# the orchestrator re-reads this file on every '*next'.
version: 1
activation:
  prepend:
    - Check pending handoffs first; they are authoritative.
    - If a gate is unmet, explain the missing prerequisite in one line.
  append:
    - End with one concrete next command when possible.
  persistent_facts:
    - Atlas routing priority is handoff -> chain -> state.
  on_complete: Emit a handoff when work transitions to a different role.
chains:
  # Discovery → product definition
  - fromAgent: athena
    command: write-brief
    toAgent: athena
    nextCommand: write-prd
    reason: brief approved; draft the PRD next

  - fromAgent: athena
    command: write-prd
    toAgent: prometheus
    nextCommand: write-architecture
    reason: PRD ready; hand to architect
    requires:
      hasPRD: true

  # Architecture exists but the Six-File Context Pack hasn't been
  # scaffolded yet → Athena writes the pack so subsequent agents boot
  # with shared context.
  - fromAgent: prometheus
    command: write-architecture
    toAgent: athena
    nextCommand: scaffold-context-pack
    reason: architecture set; scaffold the Context Pack before UX/epics
    requires:
      hasArchitecture: true
      hasContextPack: false

  - fromAgent: athena
    command: scaffold-context-pack
    toAgent: aphrodite
    nextCommand: write-ux-spec
    reason: context pack scaffolded; UX comes next
    requires:
      hasContextPack: true

  # Architecture → UX → design system
  - fromAgent: prometheus
    command: write-architecture
    toAgent: aphrodite
    nextCommand: write-ux-spec
    reason: architecture set; UX comes next
    requires:
      hasArchitecture: true

  - fromAgent: aphrodite
    command: write-ux-spec
    toAgent: aphrodite
    nextCommand: design-system
    reason: UX flows defined; lock the design system

  - fromAgent: aphrodite
    command: design-system
    toAgent: hermes
    nextCommand: write-epics
    reason: design system locked; break the work into epics
    requires:
      artifact: design-system
      status: ready

  # Planning → execution
  - fromAgent: hermes
    command: write-epics
    toAgent: hestia
    nextCommand: write-story
    reason: epics ready; SM converts the next epic to a story

  - fromAgent: hestia
    command: write-story
    toAgent: hercules
    nextCommand: implement
    reason: story is ready; engineer picks it up
    requires:
      storyStatus: ready-for-dev

  - fromAgent: hercules
    command: implement
    toAgent: nemesis
    nextCommand: qa-review
    reason: implementation done; QA runs the gate
    requires:
      storyStatus: review

  - fromAgent: nemesis
    command: qa-review
    toAgent: hestia
    nextCommand: write-story
    reason: story passed QA; back to SM for the next slice

  # Release / docs (fan-in)
  - fromAgent: hercules
    command: release-prep
    toAgent: iris
    nextCommand: write-release-notes
    reason: code frozen; prep the release artifacts

  - fromAgent: iris
    command: write-release-notes
    toAgent: apollo
    nextCommand: write-docs
    reason: release shipped; refresh user-facing docs
`;

export const BUILTIN_WORKFLOWS: readonly BuiltinFile[] = [
  { relPath: 'workflows/chains.yaml', content: CHAINS_YAML }
];
