/**
 * Curated catalog of suggested MCP servers shown in the TUI's
 * `/mcps add` overlay. Intentionally narrow — the goal is "things the
 * average atlas user will plug in", not exhaustive coverage. Power
 * users can always edit `~/.atlas/config.yaml` directly to add anything
 * the MCP ecosystem ships.
 */

export interface McpEnvVarSpec {
  readonly key: string;
  readonly description: string;
  readonly required: boolean;
  /** Hint only — no validation enforced at config time. */
  readonly placeholder?: string;
}

/**
 * Pricing/runtime tag rendered next to each row in the picker so the
 * user can tell at a glance what they're committing to.
 *  - `free`     : runs locally, no account needed.
 *  - `freemium` : runs locally or hosted; the service has a free tier
 *                 with paid upgrades (e.g. Brave Search 2k req/month).
 *  - `paid`     : the underlying service costs money to use (e.g.
 *                 Higgsfield generation credits).
 *  - `byo`      : "bring your own" — free tool, but you supply
 *                 credentials to a third-party service (Slack, Postgres).
 */
export type McpPricing = 'free' | 'freemium' | 'paid' | 'byo';

/**
 * What the user needs installed locally before this stdio entry will
 * run. The TUI checks `bin` against PATH at /mcps add time and offers
 * the install path if it's missing.
 */
export interface PrerequisiteSpec {
  /** Binary name passed to PATH lookup. */
  readonly bin: string;
  /** Short label shown as the runtime tag in the catalog. */
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
  readonly pricing: McpPricing;
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
  /**
   * Auth flows the picker should offer before collecting env vars.
   * When omitted, the picker goes straight to env collection (current
   * behaviour). When set, the user picks one of:
   *  - 'oauth-gh' : pull a token from `gh auth token` (requires `gh`
   *                 CLI installed and signed in). Maps to the env var
   *                 named in `oauthEnvKey`.
   *  - 'pat'      : prompt for the env var(s) declared in `env`.
   */
  readonly authMethods?: readonly ('oauth-gh' | 'pat')[];
  /** Which env key receives the OAuth token. Required when 'oauth-gh' is offered. */
  readonly oauthEnvKey?: string;
}

export interface HttpSuggestion extends BaseSuggestion {
  readonly transport: 'http';
  readonly url: string;
  /**
   * Template specifying how each collected env var maps onto a header.
   * Example: `{ Authorization: 'Bearer ${HIGGSFIELD_API_KEY}' }`.
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

const GITHUB_BIN_PREREQ: PrerequisiteSpec = {
  bin: 'github-mcp-server',
  label: 'binary',
  docsUrl: 'https://github.com/github/github-mcp-server/releases'
};

/**
 * A built-in stdio entry that we want shipped on by default for new
 * atlas installs. Used by the init command (and any future first-run
 * provisioning) to seed `~/.atlas/config.yaml` with a working memory
 * MCP without the user having to think about it.
 */
export const DEFAULT_BUILTIN_MCP_SERVERS = [
  {
    name: 'memory',
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {} as Record<string, string>,
    headers: {} as Record<string, string>,
    enabled: true
  }
];

export const MCP_SUGGESTIONS: readonly McpServerSuggestion[] = [
  {
    id: 'filesystem',
    name: 'filesystem',
    transport: 'stdio',
    summary: 'Read/write files in a sandboxed root directory.',
    pricing: 'free',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    env: [],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    prerequisite: NPX_PREREQ
  },
  {
    id: 'github',
    name: 'github',
    transport: 'stdio',
    summary: 'GitHub API access (issues, PRs, repos, code search).',
    pricing: 'byo',
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
    prerequisite: GITHUB_BIN_PREREQ,
    authMethods: ['oauth-gh', 'pat'],
    oauthEnvKey: 'GITHUB_PERSONAL_ACCESS_TOKEN'
  },
  {
    id: 'higgsfield',
    name: 'higgsfield',
    transport: 'http',
    summary: 'Higgsfield — image + video generation MCP (hosted).',
    pricing: 'paid',
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
    pricing: 'freemium',
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
