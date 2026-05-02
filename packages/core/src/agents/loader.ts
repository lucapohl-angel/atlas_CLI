/**
 * Agent loader + registry. Mirrors the skill loader.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { BUILTIN_AGENTS } from '../builtins/index.js';
import { atlasError, type AtlasError } from '../errors.js';
import { childLogger } from '../logger.js';
import { err, ok, type Result } from '../result.js';
import type { Skill } from '../skills/types.js';
import { renderSkillIndex } from '../skills/loader.js';
import { renderInteractionInstructions } from '../protocol/interaction.js';
import { AgentFrontmatterSchema, type Agent } from './types.js';

const log = childLogger('agents');

export const DEFAULT_AGENTS_DIR: string = join(homedir(), '.atlas', 'agents');

export interface LoadAgentsOptions {
  readonly dir?: string;
  readonly cwd?: string;
  readonly home?: string;
}

const parseAgentMarkdown = (raw: string, path: string): Agent | undefined => {
  const parsed = matter(raw);
  const fm = AgentFrontmatterSchema.safeParse(parsed.data);
  if (!fm.success) {
    log.warn({ agentPath: path, issues: fm.error.issues }, 'skipping agent: invalid frontmatter');
    return undefined;
  }
  return { ...fm.data, path, systemPrompt: parsed.content.trim() };
};

export const loadAgents = async (
  options: LoadAgentsOptions = {}
): Promise<Result<readonly Agent[], AtlasError>> => {
  const parseDir = async (dir: string): Promise<Agent[]> => {
    let entries: string[];
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) return [];
      entries = await readdir(dir);
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return [];
      throw e;
    }

    const agents: Agent[] = [];
    for (const entry of entries) {
      const agentPath = join(dir, entry, 'AGENT.md');
      try {
        const raw = await readFile(agentPath, 'utf8');
        const parsed = parseAgentMarkdown(raw, agentPath);
        if (parsed) agents.push(parsed);
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOENT') continue;
        log.warn({ agentPath, err: e }, 'skipping unreadable AGENT.md');
      }
    }
    return agents;
  };

  try {
    const layers: Agent[][] = [];
    if (options.dir) {
      layers.push(await parseDir(options.dir));
    } else {
      const builtins: Agent[] = [];
      for (const a of BUILTIN_AGENTS) {
        const parsed = parseAgentMarkdown(a.content, `builtin:${a.relPath}`);
        if (parsed) builtins.push(parsed);
      }
      const home = options.home ?? homedir();
      const cwd = options.cwd ?? process.cwd();
      layers.push(builtins);
      layers.push(await parseDir(join(home, '.atlas', 'agents')));
      layers.push(await parseDir(join(cwd, '.atlas', 'agents')));
    }

    const merged = new Map<string, Agent>();
    for (const layer of layers) {
      for (const a of layer) {
        const cur = merged.get(a.name);
        if (!cur) {
          merged.set(a.name, a);
          continue;
        }
        merged.set(a.name, {
          ...cur,
          ...a,
          handoffs: a.handoffs.length > 0 ? a.handoffs : cur.handoffs,
          commands: a.commands.length > 0 ? a.commands : cur.commands,
          systemPrompt: a.systemPrompt.length > 0 ? a.systemPrompt : cur.systemPrompt
        });
      }
    }
    return ok([...merged.values()]);
  } catch (e) {
    const dir = options.dir ?? DEFAULT_AGENTS_DIR;
    return err(
      atlasError('AGENT_PARSE_FAILED', `failed to scan agents dir ${dir}`, { cause: e })
    );
  }
};

export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  constructor(initial: readonly Agent[] = []) {
    for (const a of initial) this.agents.set(a.name, a);
  }

  list(): readonly Agent[] {
    return [...this.agents.values()];
  }

  get(name: string): Agent | undefined {
    return this.agents.get(name);
  }
}

/**
 * Build the system prompt for an agent.
 *
 * Order is deliberate: the agent's SDD role + body goes FIRST so the
 * model anchors on the role, not the persona alias. Sections follow:
 *   1. Role frame      ("You are operating as the <role> in Atlas's SDD pipeline...")
 *   2. Persona body    (markdown body from the AGENT.md file)
 *   3. Persona alias   (one tasteful line if `personaAlias` is set)
 *   4. Commands        (`*command` palette)
 *   5. Mode            (plan vs build expectations)
 *   6. Skills          (one-line index, agent loads via `skill_view`)
 *   7. Handoff rules
 *   8. Interaction protocol (how to ask structured questions)
 */
/**
 * Optional runtime context injected into the system prompt so the
 * model can answer simple identity questions ("what model are you?",
 * "what tool am I in?") without hallucinating. None of these fields
 * are sensitive — they're already visible in the TUI header — but we
 * pass them as data, not instructions.
 */
export interface SystemPromptContext {
  /** Active model id, e.g. "gpt-5.5" or "anthropic/claude-opus-4.7". */
  readonly model?: string;
  /** Provider label shown to the user, e.g. "OpenAI (ChatGPT)". */
  readonly providerLabel?: string;
  /** Atlas CLI version, e.g. "0.1.0". */
  readonly atlasVersion?: string;
}

export const buildSystemPrompt = (
  agent: Agent,
  skills: readonly Skill[],
  context: SystemPromptContext = {}
): string => {
  const sections: string[] = [];

  sections.push(
    `You are operating as the **${agent.role}** agent inside Atlas, a spec-driven development (SDD) CLI for software engineers. Your output drives real code, real files, and real conversations with the user. Be precise, concise, and honest about uncertainty.`
  );

  sections.push(renderSelfKnowledge(agent, context));

  sections.push(agent.systemPrompt.trim());

  if (agent.personaAlias) {
    sections.push(
      `_Identity alias_: When introducing yourself, you may say "I am ${agent.personaAlias}". This alias is purely cosmetic — your role and behaviour are defined by the ${agent.role} responsibilities above.`
    );
  }

  if (agent.voiceDna && agent.voiceDna.length > 0) {
    sections.push(
      `## Voice DNA\n\nWrite in this voice — every turn, every artefact:\n\n${agent.voiceDna.map((v) => `- ${v}`).join('\n')}`
    );
  }

  if (agent.activation && agent.activation.trim().length > 0) {
    sections.push(`## Activation\n\n${agent.activation.trim()}`);
  }

  if (agent.capabilityBoundaries && agent.capabilityBoundaries.length > 0) {
    sections.push(
      `## Boundaries\n\nThese are out of scope for you. Do NOT do them — even when asked. Recommend the right specialist instead.\n\n${agent.capabilityBoundaries.map((b) => `- ${b}`).join('\n')}`
    );
  }

  if (agent.commands.length > 0) {
    const cmdList = agent.commands
      .map((c) => `- \`*${c.name}\` — ${c.description}`)
      .join('\n');
    sections.push(
      `## Commands\n\nThe user can invoke any of the following with the \`*<command>\` syntax. When you see one in the user's message, execute it directly — do not ask for confirmation unless the command itself is destructive.\n\n${cmdList}`
    );
  }

  if (agent.templates && agent.templates.length > 0) {
    sections.push(
      `## Templates\n\nWhen producing one of these artefacts, render the matching template instead of free-writing:\n\n${agent.templates.map((t) => `- \`${t}\``).join('\n')}`
    );
  }

  if (agent.checklists && agent.checklists.length > 0) {
    sections.push(
      `## Checklists (definition-of-done)\n\nBefore handing off, run each of these and resolve every blocking item:\n\n${agent.checklists.map((c) => `- \`${c}\``).join('\n')}`
    );
  }

  if (agent.dataRefs && agent.dataRefs.length > 0) {
    sections.push(
      `## Data references\n\nThese are reference libraries you can consult on demand (read with \`read_file\` if you need the contents):\n\n${agent.dataRefs.map((d) => `- \`${d}\``).join('\n')}`
    );
  }

  if (agent.examples && agent.examples.length > 0) {
    const blocks = agent.examples.map((e, i) => {
      const note = e.note ? `\n_Why it works_: ${e.note}` : '';
      return `### Example ${i + 1}\n\n_Input_: ${e.input}\n\n_Output_:\n\n${e.output}${note}`;
    });
    sections.push(`## Reference outputs\n\n${blocks.join('\n\n')}`);
  }

  if (agent.authorizedSections && agent.authorizedSections.length > 0) {
    sections.push(
      `## Story authoring\n\nYou are authorized to write to these sections of a story / spec file: ${agent.authorizedSections.map((s) => `\`${s}\``).join(', ')}.${
        agent.forbiddenSections && agent.forbiddenSections.length > 0
          ? ` You are FORBIDDEN from touching: ${agent.forbiddenSections.map((s) => `\`${s}\``).join(', ')}.`
          : ''
      } The \`story_update\` tool enforces this at the boundary.`
    );
  } else if (agent.forbiddenSections && agent.forbiddenSections.length > 0) {
    sections.push(
      `## Story authoring\n\nYou are FORBIDDEN from writing to these sections of a story / spec file: ${agent.forbiddenSections.map((s) => `\`${s}\``).join(', ')}. The \`story_update\` tool enforces this at the boundary.`
    );
  }

  sections.push(modeSection(agent.mode));

  if (skills.length > 0) {
    // Learned skills are scoped to framework agents: they are auto-generated
    // by the self-improvement loop and only intended to assist the curated
    // SDD pipeline (atlas/athena/prometheus/etc.). User agents see only
    // hand-authored skills.
    const visible =
      agent.kind === 'framework'
        ? skills
        : skills.filter((s) => s.kind !== 'learned');
    if (visible.length > 0) {
      sections.push(
        `## Available skills\n\nCall \`skill_view <name>\` to load the full body of a skill.\n\n${renderSkillIndex(visible)}`
      );
    }
  }

  if (agent.handoffs.length > 0) {
    sections.push(
      `## Handoff rules\n\n${agent.handoffs
        .map((h) => `- When ${h.when} → handoff to **${h.to}**`)
        .join('\n')}`
    );
  }

  sections.push(renderInteractionInstructions());

  return sections.join('\n\n');
};

/**
 * Self-knowledge block. Lets the model honestly answer questions like
 * "what model are you?" or "what tool am I in?" without guessing.
 * Only includes information already visible to the user in the TUI
 * header (no secrets, no auth state, no filesystem paths).
 */
const renderSelfKnowledge = (agent: Agent, ctx: SystemPromptContext): string => {
  const lines: string[] = ['## About your runtime'];
  lines.push(
    'You are running inside **Atlas CLI**, an open-source spec-driven development tool that orchestrates multiple AI providers (OpenRouter, Anthropic, ChatGPT/Codex) behind a unified terminal UI. Atlas is the harness; the underlying intelligence comes from the model identified below.'
  );
  if (ctx.model) {
    lines.push(`- **Model**: \`${ctx.model}\`${ctx.providerLabel ? ` (served by ${ctx.providerLabel})` : ''}`);
  }
  lines.push(`- **Active agent**: ${agent.name} — role: ${agent.role}, mode: ${agent.mode}`);
  if (ctx.atlasVersion) lines.push(`- **Atlas version**: ${ctx.atlasVersion}`);
  lines.push(
    'When the user asks which model or tool they are talking to, answer plainly using the facts above. Do not claim ignorance about your own model id when it is listed here. Do not invent capabilities the model does not have.'
  );
  return lines.join('\n');
};

const modeSection = (mode: 'plan' | 'build' | 'autopilot'): string => {
  switch (mode) {
    case 'plan':
      return `## Mode: plan\n\nYou are in read-only/advisory mode. Read files freely, but **do not** write files or run terminal commands without an explicit user instruction. Prefer producing a plan the user can review.`;
    case 'build':
      return `## Mode: build\n\nYou have full tool access subject to the per-tool approval policy. Use tools freely to read context, write files, and run commands. Always run the project's test/typecheck command after non-trivial changes.`;
    case 'autopilot':
      return `## Mode: autopilot\n\nThe user has granted blanket approval for this session. You may use any tool without asking — including writes and terminal commands — but you remain accountable for safety. Avoid destructive irreversible operations (rm -rf, force pushes, dropping data) unless the user explicitly asked for them. Always run the project's test/typecheck command after non-trivial changes and report what you did.`;
  }
};
