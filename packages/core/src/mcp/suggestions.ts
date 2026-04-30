/**
 * Curated catalog of "official" or otherwise well-known MCP servers we
 * suggest in the TUI. All of these run over stdio so they fit the current
 * client transport. Anything requiring HTTP+OAuth (Higgsfield, Figma)
 * is intentionally excluded until the HTTP transport lands.
 */

export interface McpEnvVarSpec {
  readonly key: string;
  readonly description: string;
  readonly required: boolean;
  /** Hint only — no validation enforced at config time. */
  readonly placeholder?: string;
}

export interface McpServerSuggestion {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Env vars the user must supply at add-time. */
  readonly env: readonly McpEnvVarSpec[];
  /** Where to read more — shown as a footer in the picker. */
  readonly docs: string;
  /** A quick note about what the user needs installed (npx, docker, uvx). */
  readonly prerequisite: 'npx' | 'docker' | 'uvx';
}

export const MCP_SUGGESTIONS: readonly McpServerSuggestion[] = [
  {
    id: 'filesystem',
    name: 'filesystem',
    summary: 'Read/write files in a sandboxed root directory.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    env: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    prerequisite: 'npx'
  },
  {
    id: 'fetch',
    name: 'fetch',
    summary: 'Fetch a URL and return its content as Markdown.',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    env: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    prerequisite: 'uvx'
  },
  {
    id: 'github',
    name: 'github',
    summary: 'GitHub API access (issues, PRs, repos, code search).',
    command: 'docker',
    args: [
      'run',
      '-i',
      '--rm',
      '-e',
      'GITHUB_PERSONAL_ACCESS_TOKEN',
      'ghcr.io/github/github-mcp-server'
    ],
    env: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        description: 'A classic or fine-grained PAT with the scopes you need.',
        required: true,
        placeholder: 'ghp_...'
      }
    ],
    docs: 'https://github.com/github/github-mcp-server',
    prerequisite: 'docker'
  },
  {
    id: 'brave-search',
    name: 'brave-search',
    summary: 'Web + local search via the Brave Search API.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: [
      {
        key: 'BRAVE_API_KEY',
        description: 'Free tier available at https://brave.com/search/api/.',
        required: true,
        placeholder: 'BSA...'
      }
    ],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    prerequisite: 'npx'
  },
  {
    id: 'sqlite',
    name: 'sqlite',
    summary: 'Query and modify a local SQLite database.',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', './atlas.db'],
    env: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    prerequisite: 'uvx'
  },
  {
    id: 'memory',
    name: 'memory',
    summary: 'Persistent knowledge-graph memory across sessions.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    prerequisite: 'npx'
  },
  {
    id: 'time',
    name: 'time',
    summary: 'Time + timezone utilities (now, convert, diff).',
    command: 'uvx',
    args: ['mcp-server-time'],
    env: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    prerequisite: 'uvx'
  },
  {
    id: 'sequential-thinking',
    name: 'sequential-thinking',
    summary: 'Structured chain-of-thought scratchpad for the model.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    env: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    prerequisite: 'npx'
  },
  {
    id: 'postgres',
    name: 'postgres',
    summary: 'Read-only PostgreSQL queries against a connection URL.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    env: [
      {
        key: 'POSTGRES_CONNECTION_STRING',
        description: 'libpq-style connection URL.',
        required: true,
        placeholder: 'postgres://user:pass@host:5432/db'
      }
    ],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    prerequisite: 'npx'
  },
  {
    id: 'slack',
    name: 'slack',
    summary: 'Read + post to Slack channels via a bot token.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: [
      {
        key: 'SLACK_BOT_TOKEN',
        description: 'Bot token from a Slack app install.',
        required: true,
        placeholder: 'xoxb-...'
      },
      {
        key: 'SLACK_TEAM_ID',
        description: 'Workspace ID (e.g. T0123ABCD).',
        required: true,
        placeholder: 'T...'
      }
    ],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    prerequisite: 'npx'
  }
] as const;

export const findSuggestion = (id: string): McpServerSuggestion | undefined =>
  MCP_SUGGESTIONS.find((s) => s.id === id);
