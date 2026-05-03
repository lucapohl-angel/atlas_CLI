/**
 * Built-in checklists shipped with `atlas init`. Each entry is a YAML
 * document conforming to `ChecklistSchema` in `@atlas/core/checklists`.
 *
 * Coverage: one per authoring template (14) plus three cross-cutting
 * gates (`pre-handoff`, `docs-ready`, `security-review`). Items are
 * binary pass/fail with `severity: blocker | warning | info`. Only
 * blocker fails fail the verdict.
 */
import type { BuiltinFile } from './index.js';

const cl = (id: string, body: string): BuiltinFile => ({
  relPath: `checklists/${id}.yaml`,
  content: body.trimStart()
});

export const BUILTIN_CHECKLISTS: readonly BuiltinFile[] = [
  // ─── Per-template gates (14) ─────────────────────────────────────────
  cl(
    'brief-ready',
    `
id: brief-ready
version: 1
title: Brief Readiness
owner: athena
appliesTo: docs/brief.md
whenToUse: Run before handing the brief to Prometheus. Brief is one page; standards are blunt.
items:
  - id: one-liner
    text: One-liner is a single sentence that any non-technical stakeholder can understand.
    severity: blocker
  - id: problem-named
    text: Problem section names a real user and a real pain in the user's words.
    severity: blocker
  - id: solution-concrete
    text: Solution section describes what we will build, not what we will think about.
    severity: blocker
  - id: differentiation
    text: Differentiation cites at least one alternative the user could choose instead.
    severity: blocker
  - id: success-signal
    text: Success Signal is one observable behavior, not a feeling.
    severity: blocker
  - id: scope-bounded
    text: In Scope is short; Out of Scope explicitly cuts the obvious-but-deferred items.
    severity: warning
`
  ),
  cl(
    'prd-ready',
    `
id: prd-ready
version: 1
title: PRD Readiness
owner: athena
appliesTo: docs/prd.md
whenToUse: Run before handing the PRD to Prometheus. Block on any failure.
items:
  - id: problem-stated
    text: Problem section is in the user's vocabulary, not internal jargon.
    severity: blocker
  - id: users-concrete
    text: Each user is a concrete persona (e.g. "indie iOS dev with a Mac"), not an abstract role.
    severity: blocker
  - id: goals-listed
    text: Goals section is non-empty and each goal is achievable in this slice.
    severity: blocker
  - id: non-goals-listed
    text: Non-Goals section exists and explicitly cuts the obvious-but-deferred items.
    severity: warning
  - id: metrics-measurable
    text: Every success metric is measurable and has a target value.
    severity: blocker
  - id: open-questions-tracked
    text: Every assumption that could not be verified is logged in Open Questions.
    severity: warning
  - id: compliance-scoped
    text: If project_kind is "regulated", the Compliance section names a compliance owner.
    severity: blocker
`
  ),
  cl(
    'research-ready',
    `
id: research-ready
version: 1
title: Market Research Readiness
owner: athena
appliesTo: docs/research/market-research.md
whenToUse: Run before citing the research in a PRD. Hallucinated competitors are blockers.
items:
  - id: competitors-real
    text: Every competitor entry has a real, verifiable URL (no invented vendors).
    severity: blocker
  - id: angles-stated
    text: Every competitor entry has an "our angle" — how we differ.
    severity: blocker
  - id: positioning-paragraph
    text: Positioning is one paragraph that answers "why us, why now".
    severity: blocker
  - id: trends-cited
    text: Trends section cites the source for each trend (URL or report name).
    severity: warning
`
  ),
  cl(
    'architecture-ready',
    `
id: architecture-ready
version: 1
title: Architecture Readiness
owner: prometheus
appliesTo: docs/architecture.md
whenToUse: Run before handing architecture to Aphrodite or Hermes.
items:
  - id: prd-grounded
    text: Architecture cites the PRD it serves; every PRD goal maps to at least one component.
    severity: blocker
  - id: components-bounded
    text: Each component has a one-sentence responsibility. Vague boundaries are rejected.
    severity: blocker
  - id: data-flow-traced
    text: Data Flow describes the critical path end-to-end without hand-waving.
    severity: blocker
  - id: interfaces-contracted
    text: Every cross-component interface has a contract and named consumers.
    severity: blocker
  - id: tradeoffs-justified
    text: Every Trade-off names what was given up and why.
    severity: blocker
  - id: risks-led
    text: Risks lead with the riskiest unknown, not the easiest one.
    severity: warning
  - id: storage-defined
    text: Storage section names the datastore(s) and any retention/PII concerns.
    severity: warning
`
  ),
  cl(
    'spike-ready',
    `
id: spike-ready
version: 1
title: Spike Readiness
owner: prometheus
appliesTo: docs/spikes/
whenToUse: Run before closing a spike and citing it in architecture. A rambling spike is not ready.
items:
  - id: question-binary
    text: Question is a yes/no or a list of options, not "investigate X".
    severity: blocker
  - id: findings-cited
    text: Findings cite real measurements, real docs, or real code — never conjecture.
    severity: blocker
  - id: recommendation-explicit
    text: Recommendation is a clear directive, not a summary of trade-offs.
    severity: blocker
`
  ),
  cl(
    'ux-spec-ready',
    `
id: ux-spec-ready
version: 1
title: UX Spec Readiness
owner: aphrodite
appliesTo: docs/ux-spec.md
whenToUse: Run before handing the UX spec to Hermes. Flows lead; screens follow.
items:
  - id: flows-first
    text: Primary Flows are listed before any screen-by-screen detail.
    severity: blocker
  - id: flows-have-failures
    text: Every primary flow names at least one failure state, not just the happy path.
    severity: blocker
  - id: tokens-referenced
    text: Design Tokens section references DESIGN.md (or docs/design-tokens.md) instead of inlining values.
    severity: warning
  - id: a11y-considered
    text: Accessibility Notes section is non-empty for any screen with input or interactive elements.
    severity: warning
`
  ),
  cl(
    'design-system-ready',
    `
id: design-system-ready
version: 1
title: DESIGN.md Readiness
owner: aphrodite
appliesTo: DESIGN.md
whenToUse: |
  Run after writing DESIGN.md and before handing the design system to engineering. Mirrors the
  google-labs-code/design.md linter rules. If \`npx @google/design.md lint\` is available,
  prefer running it and use its output as the source of truth.
items:
  - id: name-set
    text: Frontmatter declares a non-empty \`name\`.
    severity: blocker
  - id: colors-defined
    text: Frontmatter defines at least one color token.
    severity: blocker
  - id: primary-color
    text: Colors include a \`primary\` token (rule "missing-primary").
    severity: warning
  - id: typography-defined
    text: Frontmatter defines at least one typography token (rule "missing-typography").
    severity: warning
  - id: refs-resolve
    text: Every token reference of the form \`{path.to.token}\` resolves to a defined token (rule "broken-ref").
    severity: blocker
  - id: contrast-aa
    text: Every component backgroundColor / textColor pair meets WCAG AA contrast ratio of at least 4.5:1 (rule "contrast-ratio").
    severity: warning
  - id: section-order
    text: Markdown sections appear in canonical order (Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts) (rule "section-order").
    severity: warning
  - id: no-orphan-tokens
    text: No color token is defined but unreferenced by any component (rule "orphaned-tokens").
    severity: info
  - id: unique-headings
    text: 'No duplicate \`##\` section heading (spec - duplicate section is an error).'
    severity: blocker
`
  ),
  cl(
    'epic-ready',
    `
id: epic-ready
version: 1
title: Epic Readiness
owner: hermes
appliesTo: docs/epics/
whenToUse: Run before declaring an epic ready for Hestia to break into stories.
items:
  - id: value-one-sentence
    text: Value Statement fits in one sentence. If it does not fit, it is not one epic.
    severity: blocker
  - id: stories-listed
    text: Stories list is non-empty and each entry has an id, title, and one-line summary.
    severity: blocker
  - id: dod-testable
    text: Every Definition-of-Done item is testable. "Looks good" is rejected.
    severity: blocker
  - id: deferred-logged
    text: Anything cut from scope during planning is recorded in the Deferred section.
    severity: warning
`
  ),
  cl(
    'story-ready',
    `
id: story-ready
version: 1
title: Story Readiness
owner: hestia
appliesTo: docs/stories/
whenToUse: Run before assigning a story to Hercules / a developer.
items:
  - id: pr-sized
    text: Story is PR-sized (one focused change, not an epic in disguise).
    severity: blocker
  - id: ac-testable
    text: Every Acceptance Criterion is testable and numbered for citation.
    severity: blocker
  - id: files-listed
    text: Affected Files lists each file with new|modified.
    severity: blocker
  - id: architecture-embedded
    text: Architecture Context contains the verbatim excerpt — not just a link.
    severity: blocker
  - id: out-of-scope-noted
    text: Out of Scope explicitly cuts work the implementer might otherwise pull in.
    severity: warning
`
  ),
  cl(
    'story-done',
    `
id: story-done
version: 1
title: Story Done
appliesTo: docs/stories/
whenToUse: Run before marking a story in-review. Owned by both Hestia and Hercules; either may run it.
editors: [hestia, hercules]
items:
  - id: ac-met
    text: Every Acceptance Criterion is met; verdicts are cited by AC number.
    severity: blocker
  - id: tests-green
    text: All tests pass locally (\`pnpm test:run\` or equivalent).
    severity: blocker
  - id: typecheck-clean
    text: Typecheck passes with zero errors.
    severity: blocker
  - id: lint-clean
    text: Lint passes with zero errors (skip if no lint script).
    severity: warning
  - id: no-out-of-scope
    text: No out-of-scope work was done; if scope grew, it was negotiated with the SM.
    severity: blocker
  - id: change-log-updated
    text: Story Change Log records the implementation entry with timestamp and author.
    severity: warning
`
  ),
  cl(
    'qa-pass',
    `
id: qa-pass
version: 1
title: QA Pass
owner: nemesis
appliesTo: docs/qa/
whenToUse: Nemesis self-check before submitting the QA report. Distinguishes "found nothing" from "did not look".
items:
  - id: every-ac-verdicted
    text: Every Acceptance Criterion has a pass | fail | blocked verdict.
    severity: blocker
  - id: defects-evidenced
    text: Every defect cites the input, the observed output, and the expected output.
    severity: blocker
  - id: severity-assigned
    text: Every defect has a severity (blocker | high | medium | low).
    severity: blocker
  - id: regression-tests
    text: At least one regression test was added for any defect with severity >= medium.
    severity: warning
  - id: verdict-explicit
    text: Verdict is approve or send-back — never blank.
    severity: blocker
`
  ),
  cl(
    'data-model-ready',
    `
id: data-model-ready
version: 1
title: Data Model Readiness
owner: demeter
appliesTo: docs/data-model.md
whenToUse: Run before handing the data model to Hercules for implementation.
items:
  - id: tables-bounded
    text: Every table has a one-sentence purpose.
    severity: blocker
  - id: keys-defined
    text: Every table declares its primary key; foreign keys are listed where relevant.
    severity: blocker
  - id: indexes-justified
    text: Every index has a justification — query shape, expected row counts, or EXPLAIN output.
    severity: blocker
  - id: pii-handled
    text: PII Handling section covers encryption-at-rest, log redaction, and retention.
    severity: blocker
`
  ),
  cl(
    'migration-ready',
    `
id: migration-ready
version: 1
title: Migration Readiness
owner: demeter
appliesTo: migrations/
whenToUse: Run before merging a migration. Rollback is mandatory.
items:
  - id: forward-present
    text: Forward Migration SQL is present and non-empty.
    severity: blocker
  - id: rollback-present
    text: Rollback SQL is present and non-empty.
    severity: blocker
  - id: transactional-flagged
    text: Transactional flag is explicit; if false, recovery plan is documented.
    severity: blocker
  - id: backfill-planned
    text: If a data backfill is required, it is described and bounded.
    severity: warning
`
  ),
  cl(
    'release-ready',
    `
id: release-ready
version: 1
title: Release Readiness
owner: iris
appliesTo: docs/releases/
whenToUse: Run before cutting a release tag.
items:
  - id: notes-drafted
    text: Release notes are drafted with at least one Highlight item.
    severity: blocker
  - id: changelog-appended
    text: CHANGELOG.md has an entry for this version under a Keep-a-Changelog heading.
    severity: blocker
  - id: breaking-explicit
    text: Any breaking change is called out under Breaking Changes with the user-visible impact.
    severity: blocker
  - id: upgrade-notes
    text: Upgrade Notes are present when there is a breaking change.
    severity: blocker
  - id: tests-green
    text: All tests pass on the release commit.
    severity: blocker
`
  ),

  // ─── Cross-cutting gates (3) ─────────────────────────────────────────
  cl(
    'pre-handoff',
    `
id: pre-handoff
version: 1
title: Pre-Handoff
appliesTo: handoffs/
whenToUse: Generic gate every agent runs before \`handoff_emit\`. Catches the silent-handoff failure mode.
items:
  - id: artifact-named
    text: The handoff names the artifact path(s) the next agent will work on.
    severity: blocker
  - id: next-agent-named
    text: The handoff names the next agent (\`to:\`) explicitly.
    severity: blocker
  - id: open-questions-listed
    text: Any open question that the next agent needs to resolve is listed.
    severity: warning
  - id: authority-checked
    text: The next agent's authorizedSections cover what the work requires (no silent forbidden-section overwrite).
    severity: blocker
`
  ),
  cl(
    'docs-ready',
    `
id: docs-ready
version: 1
title: Docs Readiness
owner: apollo
appliesTo: README.md
whenToUse: Run before merging a README or tutorial change.
items:
  - id: value-first
    text: README leads with value, not with install instructions.
    severity: blocker
  - id: examples-runnable
    text: Every code example was verified to run from a clean clone.
    severity: blocker
  - id: examples-bounded
    text: Each README example is <= 30 lines; longer examples are linked out as tutorials.
    severity: warning
  - id: links-resolve
    text: Every external link resolves (no 404s).
    severity: warning
  - id: tutorial-prereqs
    text: Each tutorial lists prerequisites and a single coherent goal.
    severity: warning
`
  ),
  cl(
    'security-review',
    `
id: security-review
version: 1
title: Security Review
appliesTo: ./
editors: [nemesis, prometheus, hercules]
whenToUse: Run before any release that touches user-facing surfaces or auth/data paths. Mirrors OWASP Top 10 sweeps.
items:
  - id: secrets-scrubbed
    text: No API keys, tokens, or credentials are committed in source or config.
    severity: blocker
  - id: input-validated
    text: All external inputs (HTTP, file, env, CLI) are validated at the system boundary (Zod or equivalent).
    severity: blocker
  - id: authz-checked
    text: Every privileged action checks the caller's authority before executing.
    severity: blocker
  - id: deps-current
    text: Dependencies have no known critical vulnerabilities (\`npm audit\` or equivalent reports clean).
    severity: warning
  - id: logs-redacted
    text: Logs do not leak PII, secrets, or tokens.
    severity: blocker
  - id: cancellation-honored
    text: Long-running operations honor AbortSignal and exit cleanly on cancellation.
    severity: warning
`
  ),
  cl(
    'context-pack-readiness',
    `
id: context-pack-readiness
version: 1
title: Context Pack Readiness
owner: atlas
appliesTo: context/
whenToUse: Run before any coding agent (Hercules, Hephaestus, etc.) executes work on a fresh project. Verifies the Six-File Context Pack scaffolds the agent's first turn correctly.
items:
  - id: overview-present
    text: "\`context/project-overview.md\` exists and names the project, in-scope, out-of-scope, and success criteria."
    severity: blocker
  - id: standards-present
    text: "\`context/code-standards.md\` exists and names language, async model, error model, file naming, and the build-gate command."
    severity: blocker
  - id: workflow-rules-present
    text: "\`context/ai-workflow-rules.md\` exists and lists read-first files, scope rules, protected files, and verification steps."
    severity: blocker
  - id: tracker-present
    text: "\`context/progress-tracker.md\` exists and names the current phase + current goal."
    severity: blocker
  - id: tracker-fresh
    text: "\`context/progress-tracker.md\` 'Recent Decisions' reflects the last commit (the auto-tracker hook is wired and firing)."
    severity: warning
  - id: open-questions-resolved
    text: "\`context/progress-tracker.md\` 'Open Questions' is empty — every ambiguity has been resolved or explicitly deferred."
    severity: warning
  - id: architecture-aligned
    text: "\`ARCHITECTURE.md\` § Invariants (or equivalent) lists the rules the codebase must always satisfy. The pack does not contradict it."
    severity: blocker
  - id: agent-readme-points-to-pack
    text: "\`AGENTS.md\` / \`CLAUDE.md\` opens with an ordered 'Read these first' list pointing at the four context-pack files."
    severity: warning
`
  )
];
