/**
 * TUI smoke test: render the Ink App with stubbed dependencies and assert
 * the header + status bar appear. Full keypress-driven scenarios live in
 * dedicated test files when behavior gets richer.
 */
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import {
  AgentRegistry,
  SkillRegistry,
  ToolRegistry,
  allowAllPolicy,
  type Agent,
  type CompletionRequest,
  type Provider,
  type StreamEvent
} from '@atlas/core';
import { TuiApp } from './App.js';

const stubAgent: Agent = {
  name: 'hercules',
  role: 'Developer',
  description: 'writes code',
  personaAlias: 'Hercules',
  mode: 'build',
  thinkingEffort: 'low',
  model: 'anthropic/claude-sonnet-4',
  skills: [],
  handoffs: [],
  commands: [{ name: 'help', description: 'show commands' }],
  kind: 'user',
  path: '/x',
  systemPrompt: 'You build software.'
};

const noopProvider: Provider = {
  name: 'stub',
  // eslint-disable-next-line require-yield
  async *stream(_req: CompletionRequest): AsyncGenerator<StreamEvent> {
    yield { type: 'done', finishReason: 'stop' };
  }
};

describe('TuiApp', () => {
  it('renders header, input row, and status bar with at least one agent', () => {
    const agents = new AgentRegistry([stubAgent]);
    const skills = new SkillRegistry([]);
    const tools = new ToolRegistry();

    const { lastFrame } = render(
      React.createElement(TuiApp, {
        provider: noopProvider,
        agents,
        skills,
        tools,
        toolContext: { cwd: process.cwd(), approve: allowAllPolicy },
        defaultModel: 'anthropic/claude-sonnet-4',
        availableModels: ['anthropic/claude-sonnet-4'],
        initialAgentName: 'hercules'
      })
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Developer');
    expect(frame).toContain('Hercules');
    expect(frame).toContain('anthropic/claude-sonnet-4');
    expect(frame).toMatch(/Tab agent/);
    expect(frame).toMatch(/Ctrl-O model/);
  });

  it('shows a friendly error when no agents are installed', () => {
    const agents = new AgentRegistry([]);
    const skills = new SkillRegistry([]);
    const tools = new ToolRegistry();

    const { lastFrame } = render(
      React.createElement(TuiApp, {
        provider: noopProvider,
        agents,
        skills,
        tools,
        toolContext: { cwd: process.cwd(), approve: allowAllPolicy },
        defaultModel: 'anthropic/claude-sonnet-4'
      })
    );

    expect(lastFrame() ?? '').toContain('atlas init');
  });
});
