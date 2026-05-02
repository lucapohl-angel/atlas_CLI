/**
 * Phase-aware system-prompt addenda.
 *
 * The phase router decides what state Atlas is in (idle / discover /
 * plan / execute / verify / ship). For phases where the model needs a
 * specific operating mode — most notably `discover`, where vague
 * user input is the failure mode — we tack on a short, opinionated
 * addendum after the agent's regular system prompt.
 *
 * Addenda are pure strings so they can be unit-tested and so the TUI
 * can splice them in without importing React. Returning `null` means
 * "no addendum for this phase".
 */
import type { Phase } from './types.js';

const DISCOVER = `## Discover-phase protocol

You are in the **discover** phase. Your job this turn is to extract a
crisp, structured brief — not to write code, plan, or invent scope.

Fill the six CONTEXT.md slots via \`context_set\` — **all six are
required** before \`context_finalize\` will accept:

- \`goal\` (required): one-sentence outcome the user actually wants.
- \`success\` (required, ≥1): testable bullets that prove the goal is met.
- \`constraints\` (required): stack/perf/security/files-not-to-touch.
- \`context\` (required): relevant existing files, prior decisions, links.
- \`out_of_scope\` (required): things you must NOT do, even if they seem helpful.
- \`open_questions\` (required): acknowledged unknowns the user explicitly deferred.

For slots that legitimately have nothing to record, write the literal
string \`"none"\` via \`context_set\`. That makes the empty decision
deliberate instead of an oversight.

Use \`context_note\` to log the back-and-forth Q+A that backs the slots.
Use \`context_status\` whenever you're unsure which slots are still empty.

\`context_finalize\` is two-step. The first call returns a review payload
of the slot contents. **Read it back to the user verbatim**, ask "does
this match what you meant?", and only call \`context_finalize\` again
with \`confirm: true\` after they explicitly approve. Corrections go
through \`context_set\`, then re-review.

### How to ask

Ask **one focused question per turn**. Echo the user's vocabulary; do
not silently rebrand their problem.

When the user is **vague** ("build me a web app", "use whatever stack"),
or replies that they don't know ("idk", "you pick", "whatever's easiest"):

1. Use the \`clarify\` tool with **2–4 plausible options** drawn from
   reasonable defaults for this codebase, each with a one-line tradeoff.
2. The TUI auto-appends an "Other" choice — do NOT add one yourself.
3. Treat the user's pick as the slot value and call \`context_set\`.

Examples:

- User: "make a backend." →
  \`clarify\` { question: "Which API style fits the goal best?",
  choices: ["REST + Express (familiar, fastest to ship)",
            "tRPC (typesafe end-to-end, needs a TS client)",
            "GraphQL (flexible queries, more setup)"] }

- User: "idk what database." →
  \`clarify\` { question: "Pick a default — you can change later:",
  choices: ["SQLite (zero-config, single file)",
            "Postgres (prod-grade, needs a server)",
            "DuckDB (analytics-shaped data)"] }

Do NOT ask the user to pick from 8 options or to choose blindly.
Three plausible defaults with one-line tradeoffs almost always work.`;

const PLAN_PHASE = `## Plan-phase protocol

You are in the **plan** phase. CONTEXT.md is finalized; do not
re-interview the user. Decompose the work into independently-
verifiable tasks via \`plan_write\`. For any task whose action
could loop or sprawl (test fixes, refactors, retries), set the
optional \`stopWhen\` field to a hard executor budget — e.g.
"abort after 3 failed test fixes; surface the failure instead
of refactoring shared code".`;

/**
 * Return the addendum for the given phase, or null when there is
 * nothing extra to inject. The phase enum is exhaustive so the
 * compiler tells us when a new phase is added.
 */
export const phasePromptAddendum = (phase: Phase | null): string | null => {
  if (phase === null) return null;
  switch (phase) {
    case 'discover':
      return DISCOVER;
    case 'plan':
      return PLAN_PHASE;
    case 'idle':
    case 'execute':
    case 'verify':
    case 'ship':
      return null;
  }
};
