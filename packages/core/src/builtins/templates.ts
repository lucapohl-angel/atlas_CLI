/**
 * Built-in templates shipped with `atlas init`. Each entry is a YAML
 * document that conforms to `TemplateSchema` in `@atlas/core/templates`.
 *
 * Quality bar: every template advertises an owner, declares its
 * required + optional inputs, marks the discovery-heavy sections as
 * `elicit: true` so the renderer hard-fails when the agent has not
 * interviewed the user, and uses Handlebars expressions for repeatable
 * structure.
 *
 * Format: BMAD-compatible (id, version, title, owner, output, sections
 * with elicit/condition/repeatable). Atlas adds typed `inputs` and a
 * programmatic owner check enforced at the tool boundary.
 */
import type { BuiltinFile } from './index.js';

const tpl = (id: string, body: string): BuiltinFile => ({
  relPath: `templates/${id}.yaml`,
  content: body.trimStart()
});

export const BUILTIN_TEMPLATES: readonly BuiltinFile[] = [
  // ─── Athena (PM) ─────────────────────────────────────────────────────
  tpl(
    'prd',
    `
id: prd
version: 1
title: Product Requirements Document
description: Crisp PRD covering Problem, Users, Goals, Non-Goals, Success Metrics, Constraints, Open Questions.
owner: athena
output: docs/prd.md
whenToUse: Draft the canonical product requirements once discovery has produced enough signal to write each section without guessing.
inputs:
  - name: project_name
    type: string
    required: true
  - name: problem_statement
    type: text
    required: true
    description: One paragraph describing the user pain in the user's own words.
  - name: users
    type: list
    required: true
    description: Concrete user descriptions (e.g. "indie iOS dev with a Mac").
  - name: goals
    type: list
    required: true
  - name: non_goals
    type: list
    description: Explicit out-of-scope items so future scope creep is auditable.
  - name: success_metrics
    type: list
    required: true
  - name: constraints
    type: list
  - name: open_questions
    type: list
  - name: project_kind
    type: string
    description: Optional - "saas" | "internal-tool" | "enterprise" | "marketplace" | "regulated".
  - name: compliance_owner
    type: string
sections:
  - id: problem
    title: Problem
    elicit: true
    instruction: One paragraph in the user's vocabulary. Cite the load-bearing pain.
    body: |
      {{problem_statement}}
  - id: users
    title: Users
    elicit: true
    repeatable: true
    instruction: Concrete personas, not abstract roles.
    body: |
      - {{item}}
  - id: goals
    title: Goals
    elicit: true
    repeatable: true
    body: |
      - {{item}}
  - id: non-goals
    title: Non-Goals
    repeatable: true
    instruction: What we are explicitly NOT doing in this slice.
    body: |
      - {{item}}
  - id: success-metrics
    title: Success Metrics
    elicit: true
    repeatable: true
    instruction: Each metric must be measurable and have a target.
    body: |
      - {{item}}
  - id: constraints
    title: Constraints
    repeatable: true
    body: |
      - {{item}}
  - id: open-questions
    title: Open Questions
    repeatable: true
    instruction: Every assumption you could not verify lives here.
    body: |
      - {{item}}
  - id: compliance
    title: Compliance & Regulatory
    condition: project_kind == 'regulated'
    body: |
      Compliance owner: {{default compliance_owner "_(unset)_"}}
`
  ),
  tpl(
    'brief',
    `
id: brief
version: 1
title: Project Brief
description: Lightweight one-page brief for kickoff and stakeholder alignment, before the full PRD.
owner: athena
output: docs/brief.md
whenToUse: Use at the very start of a project to align on the headline before committing to a full PRD. Strictly shorter than a PRD.
inputs:
  - name: project_name
    type: string
    required: true
  - name: one_liner
    type: string
    required: true
    description: A single sentence anyone in the company can understand.
  - name: problem
    type: text
    required: true
  - name: solution
    type: text
    required: true
  - name: differentiation
    type: text
    required: true
  - name: primary_users
    type: list
    required: true
  - name: success_signal
    type: text
    required: true
  - name: in_scope
    type: list
    required: true
  - name: out_of_scope
    type: list
sections:
  - id: one-liner
    title: One-liner
    elicit: true
    body: |
      {{one_liner}}
  - id: problem
    title: The Problem
    elicit: true
    body: |
      {{problem}}
  - id: solution
    title: The Solution
    elicit: true
    body: |
      {{solution}}
  - id: differentiation
    title: What Makes This Different
    elicit: true
    body: |
      {{differentiation}}
  - id: primary-users
    title: Primary Users
    repeatable: true
    body: |
      - {{item}}
  - id: success-signal
    title: Success Signal
    elicit: true
    instruction: One observable behavior that proves the brief was right.
    body: |
      {{success_signal}}
  - id: in-scope
    title: In Scope (v1)
    repeatable: true
    body: |
      - {{item}}
  - id: out-of-scope
    title: Out of Scope (v1)
    repeatable: true
    body: |
      - {{item}}
`
  ),
  tpl(
    'market-research',
    `
id: market-research
version: 1
title: Market Research
description: Competitor scan and positioning notes; informs PRD differentiation.
owner: athena
output: docs/research/market-research.md
whenToUse: Use before the PRD when the differentiation story is not obvious. Stop before you start designing - this is research, not strategy.
inputs:
  - name: project_name
    type: string
    required: true
  - name: market_segment
    type: string
    required: true
  - name: competitors
    type: list
    required: true
    description: "Each entry should be an object {name, url, strengths, weaknesses, our_angle}."
  - name: trends
    type: list
  - name: positioning
    type: text
    required: true
sections:
  - id: market
    title: Market Segment
    elicit: true
    body: |
      {{market_segment}}
  - id: competitors
    title: Competitors
    elicit: true
    repeatable: true
    instruction: One per competitor. Cite real URLs - never invent.
    body: |
      ### {{item.name}}

      - URL: {{default item.url "_(unknown)_"}}
      - Strengths: {{default item.strengths "_(none listed)_"}}
      - Weaknesses: {{default item.weaknesses "_(none listed)_"}}
      - Our angle: {{default item.our_angle "_(tbd)_"}}
  - id: trends
    title: Trends
    repeatable: true
    body: |
      - {{item}}
  - id: positioning
    title: Positioning
    elicit: true
    instruction: One paragraph that answers "why us, why now".
    body: |
      {{positioning}}
`
  ),

  // ─── Prometheus (Architect) ──────────────────────────────────────────
  tpl(
    'architecture',
    `
id: architecture
version: 1
title: Architecture
description: Component, data-flow, and trade-off documentation grounded in the PRD.
owner: prometheus
output: docs/architecture.md
whenToUse: Draft once the PRD is approved. Refuse to draft from a thin or missing PRD - send back to Athena.
inputs:
  - name: project_name
    type: string
    required: true
  - name: prd_summary
    type: text
    required: true
    description: 3-5 sentences summarising the PRD this architecture serves.
  - name: components
    type: list
    required: true
    description: "Each entry {name, responsibility, depends_on?}."
  - name: data_flow
    type: text
    required: true
  - name: interfaces
    type: list
    required: true
    description: "Each entry {name, contract, consumers}."
  - name: storage
    type: text
    required: true
  - name: tradeoffs
    type: list
    required: true
  - name: risks
    type: list
    required: true
  - name: out_of_scope
    type: list
sections:
  - id: prd-summary
    title: PRD Summary
    elicit: true
    body: |
      {{prd_summary}}
  - id: components
    title: Components
    elicit: true
    repeatable: true
    instruction: Name + one-sentence responsibility. If you cannot, the boundary is wrong.
    body: |
      ### {{item.name}}

      {{item.responsibility}}{{#if item.depends_on}} _(depends on: {{item.depends_on}})_{{/if}}
  - id: data-flow
    title: Data Flow
    elicit: true
    instruction: How data moves between components on the critical path.
    body: |
      {{data_flow}}
  - id: interfaces
    title: Interfaces & Contracts
    repeatable: true
    body: |
      ### {{item.name}}

      Contract: {{item.contract}}
      Consumers: {{default item.consumers "_(none)_"}}
  - id: storage
    title: Storage
    body: |
      {{storage}}
  - id: tradeoffs
    title: Trade-offs
    elicit: true
    repeatable: true
    instruction: Every complexity gets its justification here. Silence is rejected.
    body: |
      - {{item}}
  - id: risks
    title: Risks
    elicit: true
    repeatable: true
    instruction: Lead with the riskiest unknown.
    body: |
      - {{item}}
  - id: out-of-scope
    title: Out of Scope
    repeatable: true
    body: |
      - {{item}}
`
  ),
  tpl(
    'spike',
    `
id: spike
version: 1
title: Architecture Spike
description: Short, focused investigation of one technical question.
owner: prometheus
output: docs/spikes/{{topic_slug}}.md
whenToUse: Use when a single architecture decision is blocking and needs evidence (benchmark, spike code, vendor lookup) before committing.
inputs:
  - name: topic
    type: string
    required: true
  - name: topic_slug
    type: string
    required: true
  - name: question
    type: text
    required: true
  - name: approach
    type: text
    required: true
  - name: findings
    type: text
    required: true
  - name: recommendation
    type: text
    required: true
sections:
  - id: question
    title: Question
    elicit: true
    instruction: Phrase the question as a yes/no or a list of options - never as "investigate X".
    body: |
      {{question}}
  - id: approach
    title: Approach
    body: |
      {{approach}}
  - id: findings
    title: Findings
    elicit: true
    instruction: Cite real measurements, real docs, real code. No conjecture.
    body: |
      {{findings}}
  - id: recommendation
    title: Recommendation
    elicit: true
    body: |
      {{recommendation}}
`
  ),

  // ─── Aphrodite (UX) ──────────────────────────────────────────────────
  tpl(
    'ux-spec',
    `
id: ux-spec
version: 1
title: UX Specification
description: Flows, screens, and tokens grounded in the PRD and architecture.
owner: aphrodite
output: docs/ux-spec.md
whenToUse: Draft once the architecture is approved. Lead with flows, never with screens.
inputs:
  - name: project_name
    type: string
    required: true
  - name: primary_flows
    type: list
    required: true
    description: "Each entry {name, trigger, steps, success, failures}."
  - name: screens
    type: list
    description: "Each entry {name, purpose, key_components}."
  - name: tokens_ref
    type: string
    description: Path to docs/design-tokens.md if separate.
  - name: a11y_notes
    type: list
sections:
  - id: flows
    title: Primary Flows
    elicit: true
    repeatable: true
    instruction: Every flow names trigger, success state, and at least one failure state.
    body: |
      ### {{item.name}}

      - Trigger: {{item.trigger}}
      - Steps:
        {{#each item.steps}}
        {{@index}}. {{this}}
        {{/each}}
      - Success: {{item.success}}
      - Failures:
        {{#each item.failures}}
        - {{this}}
        {{/each}}
  - id: screens
    title: Screens
    repeatable: true
    body: |
      ### {{item.name}}

      Purpose: {{item.purpose}}
      Key components: {{default item.key_components "_(none)_"}}
  - id: tokens
    title: Design Tokens
    instruction: Reference docs/design-tokens.md. Inline only the deltas.
    body: |
      See {{default tokens_ref "docs/design-tokens.md"}}.
  - id: a11y
    title: Accessibility Notes
    repeatable: true
    body: |
      - {{item}}
`
  ),
  tpl(
    'design-system',
    `
id: design-system
version: 1
title: DESIGN.md
description: "Design system in google-labs-code/design.md format (alpha 0.1.0). YAML token frontmatter + canonical markdown sections."
owner: aphrodite
output: DESIGN.md
whenToUse: "Use to author or refresh the project's design system in the DESIGN.md format consumed by the @google/design.md linter and exporters. Lint with \`npx @google/design.md lint DESIGN.md\` after writing."
inputs:
  - name: name
    type: string
    required: true
    description: "Design system name (frontmatter \`name\` field)."
  - name: description
    type: string
    description: "Optional one-sentence description for the frontmatter."
  - name: frontmatter_yaml
    type: text
    required: true
    description: "Verbatim YAML body for the frontmatter (colors, typography, rounded?, spacing?, components?). Must include a \`primary\` color and at least one typography token. Token references use {path.to.token}."
  - name: overview
    type: text
    required: true
    description: "Brand voice + style intent in one short paragraph."
  - name: colors_prose
    type: text
    required: true
    description: "Markdown bullets explaining the role of each color token."
  - name: typography_prose
    type: text
    required: true
    description: "Markdown describing each type token's role."
  - name: layout_prose
    type: text
  - name: elevation_prose
    type: text
  - name: shapes_prose
    type: text
  - name: components_prose
    type: text
  - name: dos_and_donts
    type: text
preamble: |+
  ---
  name: {{name}}{{#if description}}
  description: {{description}}{{/if}}
  {{frontmatter_yaml}}
  ---

sections:
  - id: overview
    title: Overview
    elicit: true
    instruction: One short paragraph naming the brand voice and visual intent.
    body: |
      {{overview}}
  - id: colors
    title: Colors
    elicit: true
    instruction: Bullet each color token with its role; cite by name, not hex (the frontmatter is the source of truth).
    body: |
      {{colors_prose}}
  - id: typography
    title: Typography
    elicit: true
    instruction: Describe each type token's role (e.g. h1 for headlines, body-md for prose).
    body: |
      {{typography_prose}}
  - id: layout
    title: Layout
    condition: layout_prose
    body: |
      {{layout_prose}}
  - id: elevation
    title: Elevation & Depth
    condition: elevation_prose
    body: |
      {{elevation_prose}}
  - id: shapes
    title: Shapes
    condition: shapes_prose
    body: |
      {{shapes_prose}}
  - id: components
    title: Components
    condition: components_prose
    body: |
      {{components_prose}}
  - id: dos-and-donts
    title: Do's and Don'ts
    condition: dos_and_donts
    body: |
      {{dos_and_donts}}
`
  ),

  // ─── Hermes (PO) ─────────────────────────────────────────────────────
  tpl(
    'epic',
    `
id: epic
version: 1
title: Epic
description: One vertical slice that ships visible value.
owner: hermes
output: docs/epics/{{epic_slug}}.md
whenToUse: Draft one epic file per shippable slice. Order by first-shippable-value.
inputs:
  - name: epic_name
    type: string
    required: true
  - name: epic_slug
    type: string
    required: true
  - name: value_statement
    type: string
    required: true
    description: One sentence. If it does not fit, it is not one epic.
  - name: components_touched
    type: list
    required: true
  - name: stories
    type: list
    required: true
    description: "Each entry {id, title, summary}."
  - name: definition_of_done
    type: list
    required: true
  - name: deferred
    type: list
sections:
  - id: value
    title: Value Statement
    elicit: true
    body: |
      {{value_statement}}
  - id: components
    title: Components Touched
    repeatable: true
    body: |
      - {{item}}
  - id: stories
    title: Stories
    elicit: true
    repeatable: true
    body: |
      - \`{{item.id}}\` **{{item.title}}** - {{item.summary}}
  - id: dod
    title: Definition of Done
    elicit: true
    repeatable: true
    instruction: Each line testable. "Looks good" is not allowed.
    body: |
      - [ ] {{item}}
  - id: deferred
    title: Deferred (Cut Scope)
    repeatable: true
    instruction: Every cut item is logged here so the cut is auditable.
    body: |
      - {{item}}
`
  ),

  // ─── Hestia (SM) ─────────────────────────────────────────────────────
  tpl(
    'story',
    `
id: story
version: 1
title: Story
description: PR-sized story file the implementer can execute without re-reading the PRD/architecture.
owner: hestia
output: docs/stories/{{story_id}}.md
whenToUse: Use to break an epic into one focused, ready-to-implement story per file. Embed architecture context verbatim - do not link.
inputs:
  - name: story_id
    type: string
    required: true
  - name: title
    type: string
    required: true
  - name: epic
    type: string
    required: true
  - name: goal
    type: string
    required: true
  - name: acceptance_criteria
    type: list
    required: true
  - name: affected_files
    type: list
    required: true
    description: 'Each entry {path, change} where change is new | modified.'
  - name: architecture_excerpt
    type: text
    required: true
    description: Verbatim copy from docs/architecture.md so the dev does not have to look it up.
  - name: out_of_scope
    type: list
sections:
  - id: goal
    title: Goal
    elicit: true
    instruction: What the user can do once this story ships.
    body: |
      {{goal}}
  - id: acceptance
    title: Acceptance Criteria
    elicit: true
    repeatable: true
    instruction: Each criterion testable. Implementer cites by number when claiming completion.
    body: |
      - [ ] {{item}}
  - id: affected
    title: Affected Files
    elicit: true
    repeatable: true
    body: |
      - \`{{item.path}}\` ({{item.change}})
  - id: architecture
    title: Architecture Context
    elicit: true
    instruction: Verbatim excerpt from docs/architecture.md. Embed - never just link.
    body: |
      > {{architecture_excerpt}}
  - id: out-of-scope
    title: Out of Scope
    repeatable: true
    body: |
      - {{item}}
`
  ),

  // ─── Nemesis (QA) ────────────────────────────────────────────────────
  tpl(
    'qa-report',
    `
id: qa-report
version: 1
title: QA Report
description: Adversarial review of an in-review story; defects + suggestions + regression tests added.
owner: nemesis
output: docs/qa/{{story_id}}.md
whenToUse: Run after the implementer marks a story in-review. Distinguish defects (must-fix) from suggestions (nice-to-have).
inputs:
  - name: story_id
    type: string
    required: true
  - name: reviewer
    type: string
    required: true
  - name: criteria_status
    type: list
    required: true
    description: 'Each entry {number, status} where status is pass | fail | blocked.'
  - name: defects
    type: list
    description: "Each entry {input, observed, expected, severity}."
  - name: suggestions
    type: list
  - name: regression_tests
    type: list
    description: "Each entry {file, summary}."
  - name: verdict
    type: string
    required: true
    description: 'approve | send-back.'
sections:
  - id: criteria
    title: Acceptance Criteria Status
    elicit: true
    repeatable: true
    body: |
      - AC{{item.number}}: **{{upper item.status}}**
  - id: defects
    title: Defects (must-fix)
    repeatable: true
    instruction: Cite the input, the observed output, and the expected output. Never "feels off".
    body: |
      ### Defect ({{default item.severity "high"}})

      - Input: \`{{item.input}}\`
      - Observed: {{item.observed}}
      - Expected: {{item.expected}}
  - id: suggestions
    title: Suggestions (nice-to-have)
    repeatable: true
    body: |
      - {{item}}
  - id: regression
    title: Regression Tests Added
    repeatable: true
    body: |
      - \`{{item.file}}\` - {{item.summary}}
  - id: verdict
    title: Verdict
    elicit: true
    body: |
      **{{upper verdict}}**
`
  ),

  // ─── Demeter (Data) ──────────────────────────────────────────────────
  tpl(
    'data-model',
    `
id: data-model
version: 1
title: Data Model
description: Tables, indexes, and constraints, with justification per index.
owner: demeter
output: docs/data-model.md
whenToUse: Use when the application needs persistent storage. Profile expected query shapes before adding indexes.
inputs:
  - name: project_name
    type: string
    required: true
  - name: tables
    type: list
    required: true
    description: "Each entry {name, purpose, columns, primary_key, foreign_keys?}."
  - name: indexes
    type: list
    description: "Each entry {table, columns, justification}."
  - name: pii_handling
    type: text
    required: true
sections:
  - id: tables
    title: Tables
    elicit: true
    repeatable: true
    body: |
      ### {{item.name}}

      Purpose: {{item.purpose}}

      Columns:
      {{#each item.columns}}
      - {{this}}
      {{/each}}

      Primary key: \`{{item.primary_key}}\`
      {{#if item.foreign_keys}}Foreign keys:
      {{#each item.foreign_keys}}
      - {{this}}
      {{/each}}{{/if}}
  - id: indexes
    title: Indexes
    repeatable: true
    instruction: Every index has a justification - cite EXPLAIN output or expected row counts.
    body: |
      - \`{{item.table}}({{item.columns}})\` - {{item.justification}}
  - id: pii
    title: PII Handling
    elicit: true
    instruction: Encrypted-at-rest? Redacted in logs? Retention?
    body: |
      {{pii_handling}}
`
  ),
  tpl(
    'migration',
    `
id: migration
version: 1
title: Database Migration
description: One migration plus its rollback path.
owner: demeter
output: migrations/{{timestamp}}_{{slug}}.sql
whenToUse: Use for every schema change. The rollback path is mandatory and ships in the same change.
inputs:
  - name: slug
    type: string
    required: true
  - name: timestamp
    type: string
    required: true
  - name: summary
    type: string
    required: true
  - name: forward_sql
    type: text
    required: true
  - name: rollback_sql
    type: text
    required: true
  - name: transactional
    type: boolean
    required: true
  - name: data_backfill
    type: text
sections:
  - id: summary
    title: Summary
    elicit: true
    body: |
      {{summary}}
  - id: transactional
    title: Transactional
    elicit: true
    body: |
      {{#if transactional}}Yes - wrapped in BEGIN/COMMIT.{{else}}**No** - flagged as non-transactional. Document the recovery plan below.{{/if}}
  - id: forward
    title: Forward Migration
    elicit: true
    body: |
      \`\`\`sql
      {{forward_sql}}
      \`\`\`
  - id: rollback
    title: Rollback
    elicit: true
    instruction: Every migration has a rollback. No exceptions.
    body: |
      \`\`\`sql
      {{rollback_sql}}
      \`\`\`
  - id: backfill
    title: Data Backfill
    condition: data_backfill
    body: |
      {{data_backfill}}
`
  ),

  // ─── Iris (Release) ──────────────────────────────────────────────────
  tpl(
    'release-notes',
    `
id: release-notes
version: 1
title: Release Notes
description: User-facing notes for a released version.
owner: iris
output: docs/releases/{{version}}.md
whenToUse: Draft per release. Speak to users; technical detail belongs in CHANGELOG.md.
inputs:
  - name: version
    type: string
    required: true
  - name: date
    type: string
    required: true
  - name: highlights
    type: list
    required: true
  - name: improvements
    type: list
  - name: fixes
    type: list
  - name: breaking
    type: list
  - name: upgrade_notes
    type: text
sections:
  - id: header
    title: "Release {{version}} - {{date}}"
    body: |
      _(intro)_
  - id: highlights
    title: Highlights
    elicit: true
    repeatable: true
    body: |
      - {{item}}
  - id: improvements
    title: Improvements
    repeatable: true
    body: |
      - {{item}}
  - id: fixes
    title: Bug Fixes
    repeatable: true
    body: |
      - {{item}}
  - id: breaking
    title: Breaking Changes
    repeatable: true
    instruction: Be explicit. List the user-visible impact, not the internal symbol that changed.
    body: |
      - {{item}}
  - id: upgrade
    title: Upgrade Notes
    condition: upgrade_notes
    body: |
      {{upgrade_notes}}
`
  ),
  tpl(
    'changelog-entry',
    `
id: changelog-entry
version: 1
title: Changelog Entry
description: Single Keep-a-Changelog entry composed from grouped commits.
owner: iris
output: CHANGELOG.md
whenToUse: Use to append one entry per version under Keep-a-Changelog headings.
inputs:
  - name: version
    type: string
    required: true
  - name: date
    type: string
    required: true
  - name: added
    type: list
  - name: changed
    type: list
  - name: deprecated
    type: list
  - name: removed
    type: list
  - name: fixed
    type: list
  - name: security
    type: list
sections:
  - id: header
    title: "[{{version}}] - {{date}}"
    body: |
      _(generated entry)_
  - id: added
    title: Added
    repeatable: true
    body: |
      - {{item}}
  - id: changed
    title: Changed
    repeatable: true
    body: |
      - {{item}}
  - id: deprecated
    title: Deprecated
    repeatable: true
    body: |
      - {{item}}
  - id: removed
    title: Removed
    repeatable: true
    body: |
      - {{item}}
  - id: fixed
    title: Fixed
    repeatable: true
    body: |
      - {{item}}
  - id: security
    title: Security
    repeatable: true
    body: |
      - {{item}}
`
  ),

  // ─── Apollo (Docs) ───────────────────────────────────────────────────
  tpl(
    'readme',
    `
id: readme
version: 1
title: README
description: Adoption-first README - value, install, quick-start, examples.
owner: apollo
output: README.md
whenToUse: Use to draft or refresh the README. Lead with value, not install. Verify every code block from a clean clone.
inputs:
  - name: project_name
    type: string
    required: true
  - name: tagline
    type: string
    required: true
  - name: value_paragraph
    type: text
    required: true
  - name: install_steps
    type: list
    required: true
  - name: quickstart
    type: text
    required: true
  - name: examples
    type: list
    description: "Each entry {title, body}. Bodies must be runnable from a clean clone."
  - name: links
    type: list
sections:
  - id: title
    title: "{{project_name}}"
    body: |
      > {{tagline}}
  - id: value
    title: Why
    elicit: true
    instruction: Lead with value, never install instructions.
    body: |
      {{value_paragraph}}
  - id: install
    title: Install
    repeatable: true
    body: |
      \`\`\`sh
      {{item}}
      \`\`\`
  - id: quickstart
    title: Quick Start
    elicit: true
    body: |
      {{quickstart}}
  - id: examples
    title: Examples
    repeatable: true
    instruction: Each example <=30 lines. Anything longer is a tutorial - link out.
    body: |
      ### {{item.title}}

      {{item.body}}
  - id: links
    title: Links
    repeatable: true
    body: |
      - {{item}}
`
  ),
  tpl(
    'tutorial',
    `
id: tutorial
version: 1
title: Tutorial
description: End-to-end walk-through for a new user.
owner: apollo
output: docs/tutorials/{{slug}}.md
whenToUse: "Use for end-to-end guides longer than the README's <=30-line examples. Keep one coherent goal per tutorial."
inputs:
  - name: title
    type: string
    required: true
  - name: slug
    type: string
    required: true
  - name: prerequisites
    type: list
    required: true
  - name: goal
    type: string
    required: true
  - name: steps
    type: list
    required: true
    description: "Each entry {title, body}."
  - name: troubleshooting
    type: list
sections:
  - id: title
    title: "{{title}}"
    body: |
      _(tutorial)_
  - id: goal
    title: What you'll build
    elicit: true
    body: |
      {{goal}}
  - id: prereq
    title: Prerequisites
    repeatable: true
    body: |
      - {{item}}
  - id: steps
    title: Steps
    elicit: true
    repeatable: true
    body: |
      ### {{item.title}}

      {{item.body}}
  - id: troubleshooting
    title: Troubleshooting
    repeatable: true
    body: |
      - {{item}}
`
  )
];
