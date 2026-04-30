/**
 * Curated catalog of "official" or otherwise well-known MCP servers we
 * suggest in the TUI. Mix of stdio (run locally via npx/uvx/native
 * binary) and HTTP (hosted endpoints — Higgsfield, Figma).
 */

export interface McpEnvVarSpec {
  readonly key: string;
  readonly description: string;
  readonly required: boolean;
  /** Hint only — no validation enforced at config time. */
  readonly placeholder?: string;
}

/**
 * What the user needs installed locally before this stdio entry will
 * run. The TUI checks `bin` against PATH at /mcps add time and offers
 * the install path if it's missing.
 */
export interface PrerequisiteSpec {
  /** Binary name passed to PATH lookup (e.g. `npx`, `docker`, `uvx`). */
  readonly bin: string;
  /** Short label shown as the tag in the catalog. Defaults to `bin`. */
  readonly label?: string;
  /** Where humans go to install it. */
  readonly docsUrl: string;
  /**
   * A vetted, idempotent install command. Only set for installers we've
   * audited as safe to run on a user's machine without sudo (currently:
   * `uv`'s official curl|sh installer). Anything that needs sudo, kernel
   * modules, or a GUI installer (Docker) should be left undefined.
   */
  readonly autoInstall?: {
    readonly description: string;
    /** Shell command, executed via `sh -c` (or `cmd /c` on Windows). */
    readonly shell: string;
  };
}

interface BaseSuggestion {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  /** Env vars (stdio) or header tokens (http) the user must supply at add-time. */
  readonly env: readonly McpEnvVarSpec[];
  /** Where to read more — shown as a footer in the picker. */
  readonly docs: string;
}

export interface StdioSuggestion extends BaseSuggestion {
  readonly transport: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly prerequisite: PrerequisiteSpec;
}

export interface HttpSuggestion extends BaseSuggestion {
  readonly transport: 'http';
  readonly url: string;
  /**
   * Template specifying how each collected env var maps onto a header.
   * Example: `{ Authorization: 'Bearer ${HIGGSFIELD_API_KEY}' }`. The
   * `${KEY}` placeholders are substituted at add-time with the values
   * the user typed.
   */
  readonly headerTemplate: Readonly<Record<string, string>>;
}

export type McpServerSuggestion = StdioSuggestion | HttpSuggestion;

// ── Reusable prerequisite specs ──────────────────────────────────────
const NPX_PREREQ: PrerequisiteSpec = {
  bin: 'npx',
  label: 'npx',
  docsUrl: 'https://nodejs.org/en/download'
};

const UVX_PREREQ: PrerequisiteSpec = {
  bin: 'uvx',
  label: 'uvx',
  docsUrl: 'https://docs.astral.sh/uv/getting-started/installation/',
  // The uv installer is a single curl|sh, vetted by Astral. Installs
  // into ~/.local/bin without sudo. Safe to offer as a one-click.
  autoInstall: {
    description: 'Installs uv (which provides uvx) into ~/.local/bin.',
    shell: 'curl -LsSf https://astral.sh/uv/install.sh | sh'
  }
};

const GITHUB_BIN_PREREQ: PrerequisiteSpec = {
  bin: 'github-mcp-server',
  label: 'binary',
  docsUrl: 'https://github.com/github/github-mcp-server/releases'
};

export const MCP_SUGGESTIONS: readonly McpServerSuggestion[] = [
  {
    id: 'filesystem',
    name: 'filesystem',
    transport: 'stdio',
    summary: 'Read/write files in a sandboxed root directory.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    env: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    prerequisite: NPX_PREREQ
  },
  {
    id: 'fetch',
    name: 'fetch',
    transport: 'stdio',
    summary: 'Fetch a URL and return its content as Markdown.',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    env: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    prerequisite: UVX_PREREQ
  },
  {
    id: 'github',
    name: 'github',
    transport: 'stdio',
    summary: 'GitHub API access (issues, PRs, repos, code search).',
    // Standalone Go binary from github/github-mcp-server releases.
    // Single static file, no Docker required.
    command: 'github-mcp-server',
    args: ['stdio'],
    env: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        description: 'A classic or fine-grained PAT with the scopes you need.',
        required: true,
        placeholder: 'ghp_...'
      }
    ],
    docs: 'https://github.com/github/github-mcp-server',
    prerequisite: GITHUB_BIN_PREREQ
  },
  {
    id: 'brave-search',
    name: 'brave-search',
    transport: 'stdio',
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
    prerequisite: NPX_PREREQ
  },
  {
    id: 'sqlite',
    name: 'sqlite',
    transport: 'stdio',
    summary: 'Query and modify a local SQLite database.',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', './atlas.db'],
    env: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    prerequisite: UVX_PREREQ
  },
  {
    id: 'memory',
    name: 'memory',
    transport: 'stdio',
    summary: 'Persistent knowledge-graph memory across sessions (local JSON).',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    prerequisite: NPX_PREREQ
  },
  {
    id: 'time',
    name: 'time',
    transport: 'stdio',
    summary: 'Time + timezone utilities (now, convert, diff).',
    command: 'uvx',
    args: ['mcp-server-time'],
    env: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    prerequisite: UVX_PREREQ
  },
  {
    id: 'sequential-thinking',
    name: 'sequential-thinking',
    transport: 'stdio',
    summary: 'Structured chain-of-thought scratchpad for the model.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    env: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    prerequisite: NPX_PREREQ
  },
  {
    id: 'postgres',
    name: 'postgres',
    transport: 'stdio',
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
    prerequisite: NPX_PREREQ
  },
  {
    id: 'slack',
    name: 'slack',
    transport: 'stdio',
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
    prerequisite: NPX_PREREQ
  },
  // ── Hosted (Streamable HTTP) servers ──────────────────────────────
  {
    id: 'higgsfield',
    name: 'higgsfield',
    transport: 'http',
    summary: 'Higgsfield — image + video generation MCP (hosted).',
    url: 'https://higgsfield.ai/mcp',
    headerTemplate: { Authorization: 'Bearer ${HIGGSFIELD_API_KEY}' },
    env: [
      {
        key: 'HIGGSFIELD_API_KEY',
        description: 'Personal API key from https://higgsfield.ai/mcp.',
        required: true,
        placeholder: 'hgs_...'
      }
    ],
    docs: 'https://higgsfield.ai/mcp'
  },
  {
    id: 'figma',
    name: 'figma',
    transport: 'http',
    summary: 'Figma — read frames, components, and styles (hosted).',
    url: 'https://mcp.figma.com/mcp',
    headerTemplate: { Authorization: 'Bearer ${FIGMA_API_TOKEN}' },
    env: [
      {
        key: 'FIGMA_API_TOKEN',
        description: 'Personal access token from Figma → Settings → Account → Personal access tokens.',
        required: true,
        placeholder: 'figd_...'
      }
    ],
    docs: 'https://github.com/figma/mcp-server-guide'
  }
] as const;

export const findSuggestion = (id: string): McpServerSuggestion | undefined =>
  MCP_SUGGESTIONS.find((s) => s.id === id);

/**
 * Substitute `${KEY}` placeholders in every header template value with
 * the matching env var the user collected at add-time. Returns a plain
 * `Record<string,string>` ready to persist in `~/.atlas/config.yaml`.
 */
export const renderHeaders = (
  template: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string>>
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(template)) {
    out[k] = v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => env[name] ?? '');
  }
  return out;
};
