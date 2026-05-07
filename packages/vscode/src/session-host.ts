import {
  AgentRegistry,
  buildSystemPrompt,
  loadAgents,
  type Agent,
} from '@atlas/core/agents';
import { AtlasConfigSchema, loadConfig, type AtlasConfig } from '@atlas/core/config';
import { loadContextPack } from '@atlas/core/context';
import { atlasError, type AtlasError } from '@atlas/core/errors';
import { builtinHookRegistry, type HookRegistry } from '@atlas/core/hooks';
import { runAgentLoop, type LoopEvent } from '@atlas/core/loop';
import { providerFromConfigAsync, type Message, type Provider } from '@atlas/core/providers';
import { err, ok, type Result } from '@atlas/core/result';
import { SkillRegistry, loadSkills, type Skill } from '@atlas/core/skills';
import { ToolRegistry, allowAllPolicy } from '@atlas/core/tools/registry';
import type { ToolContext } from '@atlas/core/tools/types';
import { phasePromptAddendum } from '@atlas/core/workflow';

export interface CreateAtlasSessionHostOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: AtlasConfig;
  readonly provider?: Provider;
  readonly model?: string;
  readonly agentName?: string;
  readonly agents?: readonly Agent[];
  readonly skills?: readonly Skill[];
  readonly tools?: ToolRegistry;
  readonly hooks?: HookRegistry;
}

export interface RunTurnOptions {
  readonly signal?: AbortSignal;
}

interface AtlasSessionHostState {
  readonly cwd: string;
  readonly config: AtlasConfig;
  readonly provider: Provider;
  readonly model: string;
  readonly agent: Agent;
  readonly skills: SkillRegistry;
  readonly tools: ToolRegistry;
  readonly hooks: HookRegistry;
  readonly toolContext: ToolContext;
}

export class AtlasSessionHost {
  private readonly state: AtlasSessionHostState;
  private messages: readonly Message[] = [];

  public constructor(state: AtlasSessionHostState) {
    this.state = state;
  }

  public get model(): string {
    return this.state.model;
  }

  public get providerName(): string {
    return this.state.provider.name;
  }

  public get agentName(): string {
    return this.state.agent.name;
  }

  public get history(): readonly Message[] {
    return this.messages;
  }

  public async *runTurn(
    prompt: string,
    options: RunTurnOptions = {},
  ): AsyncGenerator<LoopEvent> {
    const userMessage: Message = { role: 'user', content: prompt };
    const turnHistory = [...this.messages, userMessage];
    const systemContent = await this.buildSystemContent();
    let completedMessages: readonly Message[] | null = null;

    for await (const event of runAgentLoop({
      provider: this.state.provider,
      model: this.state.model,
      fallbackModels: this.state.config.fallbackModels,
      tools: this.state.tools,
      hooks: this.state.hooks,
      toolContext: {
        ...this.state.toolContext,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      initialMessages: [{ role: 'system', content: systemContent }, ...turnHistory],
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      if (event.type === 'done') completedMessages = event.messages;
      yield event;
    }

    this.messages = completedMessages
      ? completedMessages.filter((message) => message.role !== 'system')
      : turnHistory;
  }

  private async buildSystemContent(): Promise<string> {
    let contextPack: string | undefined;
    try {
      const pack = await loadContextPack({ cwd: this.state.cwd });
      if (pack.content && pack.content.trim().length > 0) contextPack = pack.content;
    } catch {
      contextPack = undefined;
    }

    const base = buildSystemPrompt(this.state.agent, this.state.skills.list(), {
      model: this.state.model,
      providerLabel: this.state.provider.name,
      ...(contextPack ? { contextPack } : {}),
    });
    const addendum = phasePromptAddendum('discover');

    return [
      addendum ? `${base}\n\n${addendum}` : base,
      '## Output style\n\n- Do not use emoji or pictographic Unicode in replies. Use plain ASCII and Markdown only.',
    ].join('\n\n');
  }
}

export const createAtlasSessionHost = async (
  options: CreateAtlasSessionHostOptions,
): Promise<Result<AtlasSessionHost, AtlasError>> => {
  const configResult = await resolveConfig(options);
  if (!configResult.ok) return err(configResult.error);
  const config = configResult.value;

  const providerResult = await resolveProvider(config, options.provider);
  if (!providerResult.ok) return err(providerResult.error);

  const agentsResult = await resolveAgents(options.agents);
  if (!agentsResult.ok) return err(agentsResult.error);
  const agents = new AgentRegistry(agentsResult.value);
  const agent = agents.get(options.agentName ?? 'atlas') ?? agents.list()[0];
  if (!agent) {
    return err(atlasError(
      'AGENT_NOT_FOUND',
      'No Atlas agents are installed. Run `atlas init` once, then reload the VS Code extension host.',
    ));
  }

  const skillsResult = await resolveSkills(options.skills);
  if (!skillsResult.ok) return err(skillsResult.error);

  const toolContext: ToolContext = {
    cwd: options.cwd,
    approve: allowAllPolicy,
    callingAgent: {
      name: agent.name,
      ...(agent.authorizedSections ? { authorizedSections: agent.authorizedSections } : {}),
      ...(agent.forbiddenSections ? { forbiddenSections: agent.forbiddenSections } : {}),
    },
  };

  return ok(new AtlasSessionHost({
    cwd: options.cwd,
    config,
    provider: providerResult.value,
    model: options.model ?? config.defaultModel,
    agent,
    skills: new SkillRegistry(skillsResult.value),
    tools: options.tools ?? new ToolRegistry(),
    hooks: options.hooks ?? builtinHookRegistry({
      cwd: options.cwd,
      config: config.guardrails,
    }),
    toolContext,
  }));
};

const resolveConfig = async (
  options: CreateAtlasSessionHostOptions,
): Promise<Result<AtlasConfig, AtlasError>> => {
  if (options.config) return ok(options.config);
  if (options.provider) return ok(AtlasConfigSchema.parse({}));
  return loadConfig({ env: options.env ?? process.env });
};

const resolveProvider = async (
  config: AtlasConfig,
  provider: Provider | undefined,
): Promise<Result<Provider, AtlasError>> => {
  if (provider) return ok(provider);
  return providerFromConfigAsync(config);
};

const resolveAgents = async (
  agents: readonly Agent[] | undefined,
): Promise<Result<readonly Agent[], AtlasError>> => {
  if (agents) return ok(agents);
  return loadAgents();
};

const resolveSkills = async (
  skills: readonly Skill[] | undefined,
): Promise<Result<readonly Skill[], AtlasError>> => {
  if (skills) return ok(skills);
  return loadSkills();
};
