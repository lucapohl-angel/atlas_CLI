/**
 * Tool catalog — single source of truth for the `/tools` UI.
 *
 * Wraps each registered tool with display metadata (essential? managed?
 * what actions can the user take?) and a `status()` probe that the TUI
 * uses to render a colored dot.
 *
 *   ● green   — connected / running
 *   ● yellow  — degraded (e.g. installed but stopped)
 *   ● red     — disconnected / not installed
 *   ○ gray    — disabled by the user
 *
 * Persistence: the user's enable/disable choices live in
 * `~/.atlas/tools-state.json` (not the YAML config — this is operational
 * state that can change frequently and shouldn't churn user-curated
 * configuration).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { childLogger } from '../logger.js';
import { searxngPullImage, searxngRemove, searxngStart, searxngStatus, searxngStop } from './searxng-manager.js';
import { browserAvailable, closeBrowser } from './browser/session.js';

const log = childLogger('tool-catalog');

export type ToolStatusState = 'connected' | 'degraded' | 'disconnected' | 'disabled' | 'unknown';

export interface ToolStatus {
  readonly state: ToolStatusState;
  /** Short one-line detail rendered next to the dot. */
  readonly detail: string;
}

export type ToolActionId =
  | 'enable'
  | 'disable'
  | 'install'
  | 'start'
  | 'stop'
  | 'restart'
  | 'remove';

export interface ToolAction {
  readonly id: ToolActionId;
  readonly label: string;
  /** When set, UI must show this confirmation before invoking. */
  readonly warning?: string;
}

export interface CatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /**
   * Essential tools cannot be removed and only disable with a warning.
   * Almost every tool except the managed ones (searxng, browser) is
   * essential to Atlas's day-to-day operation.
   */
  readonly essential: boolean;
  /**
   * Group used purely for display ordering.
   *   core      — read/write/terminal/git that drive every workflow
   *   workflow  — story/template/checklist/handoff (SDD pipeline)
   *   web       — web_search, web_fetch, browser
   *   meta      — todo, clarify, delegate
   */
  readonly group: 'core' | 'workflow' | 'web' | 'meta';
  /** Custom status probe. When omitted we report `enabled`/`disabled`. */
  readonly probe?: () => Promise<ToolStatus>;
  /** Extra actions beyond enable/disable (install/start/stop/remove). */
  readonly extraActions?: readonly ToolAction[];
}

/**
 * Persisted state lives at `~/.atlas/tools-state.json` so the user's
 * choices survive across atlas invocations without touching config.yaml.
 */
export interface ToolsState {
  readonly disabled: readonly string[];
}

const stateFilePath = (): string => join(homedir(), '.atlas', 'tools-state.json');

export const loadToolsState = async (): Promise<ToolsState> => {
  try {
    const raw = await readFile(stateFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { disabled?: unknown };
    const disabled = Array.isArray(parsed.disabled)
      ? parsed.disabled.filter((x): x is string => typeof x === 'string')
      : [];
    return { disabled };
  } catch {
    return { disabled: [] };
  }
};

export const saveToolsState = async (state: ToolsState): Promise<void> => {
  const p = stateFilePath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify({ disabled: [...state.disabled] }, null, 2) + '\n', 'utf8');
};

export const setToolEnabled = async (name: string, enabled: boolean): Promise<ToolsState> => {
  const cur = await loadToolsState();
  const set = new Set(cur.disabled);
  if (enabled) set.delete(name);
  else set.add(name);
  const next: ToolsState = { disabled: [...set].sort() };
  await saveToolsState(next);
  return next;
};

export const isToolDisabled = async (name: string): Promise<boolean> => {
  const s = await loadToolsState();
  return s.disabled.includes(name);
};

// ---- Probes -------------------------------------------------------------

const probeWebSearch = async (): Promise<ToolStatus> => {
  const s = await searxngStatus();
  if (!s.dockerInstalled) {
    return {
      state: 'disconnected',
      detail: 'docker not installed — searxng container can\'t run'
    };
  }
  if (!s.containerExists) {
    return {
      state: 'disconnected',
      detail: 'searxng container not created — run `install`'
    };
  }
  if (!s.running) {
    return { state: 'degraded', detail: 'searxng container exists but stopped' };
  }
  return { state: 'connected', detail: `searxng @ ${s.url ?? '127.0.0.1:8080'}` };
};

const probeBrowser = async (): Promise<ToolStatus> => {
  const ok = await browserAvailable();
  if (!ok) {
    return {
      state: 'disconnected',
      detail: 'playwright not installed — run `install`'
    };
  }
  return { state: 'connected', detail: 'playwright (chromium headless)' };
};

const probeAlwaysOn = (detail: string) => async (): Promise<ToolStatus> => ({
  state: 'connected',
  detail
});

// ---- Catalog ------------------------------------------------------------

const ENTRIES: readonly CatalogEntry[] = [
  // Core — file system + process control
  {
    name: 'read_file',
    title: 'read_file',
    description: 'Read a file from the workspace.',
    essential: true,
    group: 'core',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'write_file',
    title: 'write_file',
    description: 'Write a file (with hook-controlled approval).',
    essential: true,
    group: 'core',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'terminal',
    title: 'terminal',
    description: 'Run shell commands (gated by approval policy).',
    essential: true,
    group: 'core',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'git',
    title: 'git',
    description: 'Read-only git introspection.',
    essential: true,
    group: 'core',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'gh',
    title: 'gh',
    description: 'Read-only GitHub CLI passthrough.',
    essential: false,
    group: 'core',
    probe: probeAlwaysOn('built-in')
  },

  // Workflow — SDD pipeline artefacts
  {
    name: 'story_create',
    title: 'story_create',
    description: 'Create a story file from a template.',
    essential: true,
    group: 'workflow',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'story_update',
    title: 'story_update',
    description: 'Patch a story section (per-agent authorization).',
    essential: true,
    group: 'workflow',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'handoff_emit',
    title: 'handoff_emit',
    description: 'Emit an inter-agent handoff packet.',
    essential: true,
    group: 'workflow',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'handoff_consume',
    title: 'handoff_consume',
    description: 'Consume a handoff packet.',
    essential: true,
    group: 'workflow',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'template_render',
    title: 'template_render',
    description: 'Render a workflow template.',
    essential: true,
    group: 'workflow',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'template_list',
    title: 'template_list',
    description: 'List available templates.',
    essential: false,
    group: 'workflow',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'checklist_run',
    title: 'checklist_run',
    description: 'Run a checklist against an artefact.',
    essential: true,
    group: 'workflow',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'checklist_list',
    title: 'checklist_list',
    description: 'List available checklists.',
    essential: false,
    group: 'workflow',
    probe: probeAlwaysOn('built-in')
  },

  // Meta — agent self-management
  {
    name: 'todo',
    title: 'todo',
    description: 'In-session task list (no disk persistence).',
    essential: false,
    group: 'meta',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'clarify',
    title: 'clarify',
    description: 'Ask the user a single targeted question.',
    essential: false,
    group: 'meta',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'open_question',
    title: 'open_question',
    description: 'Append an unresolved ambiguity to context/progress-tracker.md.',
    essential: false,
    group: 'meta',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'delegate',
    title: 'delegate',
    description: 'Spawn child agent(s) to handle sub-goals.',
    essential: false,
    group: 'meta',
    probe: probeAlwaysOn('built-in')
  },

  // Web — external network access
  {
    name: 'web_fetch',
    title: 'web_fetch',
    description: 'SSRF-safe fetch of a URL → plain text.',
    essential: false,
    group: 'web',
    probe: probeAlwaysOn('built-in')
  },
  {
    name: 'web_search',
    title: 'web_search (SearXNG)',
    description: 'Web search via the local SearXNG container.',
    essential: false,
    group: 'web',
    probe: probeWebSearch,
    extraActions: [
      { id: 'install', label: 'Install (pull image + start container)' },
      { id: 'start', label: 'Start container' },
      { id: 'stop', label: 'Stop container' },
      {
        id: 'remove',
        label: 'Remove container',
        warning:
          'This stops + removes the SearXNG Docker container. The image stays pulled. web_search will not work until you re-install.'
      }
    ]
  },
  {
    name: 'browser',
    title: 'browser (Playwright)',
    description: 'Headless Chromium for JS-rendered pages.',
    essential: false,
    group: 'web',
    probe: probeBrowser,
    extraActions: [
      {
        id: 'install',
        label: 'Install Chromium for Playwright (~150MB download)'
      },
      { id: 'stop', label: 'Close browser session (release RAM)' }
    ]
  }
];

export const toolCatalog = (): readonly CatalogEntry[] => ENTRIES;

export const getCatalogEntry = (name: string): CatalogEntry | undefined =>
  ENTRIES.find((e) => e.name === name);

export interface ResolvedToolStatus {
  readonly entry: CatalogEntry;
  /** True when the tool is registered with the live ToolRegistry. */
  readonly registered: boolean;
  /** True when the user has explicitly disabled it via `/tools`. */
  readonly disabled: boolean;
  readonly status: ToolStatus;
}

/**
 * Resolve current status for every catalog entry. Probes run in
 * parallel; failures degrade to `unknown` so the UI can still render.
 *
 * `registeredNames` is the set of tool names actually present in the
 * live ToolRegistry — entries missing from it are reported as
 * `disconnected` ("not registered") so the user sees them but knows
 * they're inert this session.
 */
export const resolveCatalogStatus = async (
  registeredNames: ReadonlySet<string>
): Promise<readonly ResolvedToolStatus[]> => {
  const state = await loadToolsState();
  const disabledSet = new Set(state.disabled);

  const probes = ENTRIES.map(async (entry): Promise<ResolvedToolStatus> => {
    const registered = registeredNames.has(entry.name);
    const disabled = disabledSet.has(entry.name);
    if (disabled) {
      return {
        entry,
        registered,
        disabled,
        status: { state: 'disabled', detail: 'disabled by user' }
      };
    }
    if (!registered) {
      return {
        entry,
        registered,
        disabled,
        status: { state: 'disconnected', detail: 'not registered this session' }
      };
    }
    if (entry.probe) {
      try {
        const s = await entry.probe();
        return { entry, registered, disabled, status: s };
      } catch (e) {
        log.debug({ tool: entry.name, err: (e as Error).message }, 'probe failed');
        return {
          entry,
          registered,
          disabled,
          status: { state: 'unknown', detail: 'probe failed' }
        };
      }
    }
    return { entry, registered, disabled, status: { state: 'connected', detail: 'enabled' } };
  });
  return Promise.all(probes);
};

// ---- Action runners -----------------------------------------------------

export interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
}

const installPlaywrightChromium = async (
  onProgress?: (line: string) => void
): Promise<ActionResult> => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'playwright', 'install', 'chromium'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const onLine = (chunk: Buffer): void => onProgress?.(chunk.toString('utf8'));
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);
    child.on('error', (e) =>
      resolve({ ok: false, message: `playwright install failed to spawn: ${e.message}` })
    );
    child.on('exit', (code) => {
      if (code === 0) resolve({ ok: true, message: 'chromium installed' });
      else resolve({ ok: false, message: `playwright install exited ${code}` });
    });
  });
};

/**
 * Execute one of the catalog actions. Returns a human-readable line
 * suitable for piping straight into the system transcript.
 */
export const runToolAction = async (
  toolName: string,
  action: ToolActionId,
  onProgress?: (line: string) => void
): Promise<ActionResult> => {
  const entry = getCatalogEntry(toolName);
  if (!entry) return { ok: false, message: `unknown tool: ${toolName}` };

  if (action === 'enable') {
    await setToolEnabled(toolName, true);
    return { ok: true, message: `${toolName}: enabled` };
  }
  if (action === 'disable') {
    if (entry.essential) {
      // Caller is responsible for surfacing the warning UX. We still
      // honor the request (the warning is informational, not a block).
      log.warn({ tool: toolName }, 'disabling essential tool');
    }
    await setToolEnabled(toolName, false);
    return {
      ok: true,
      message: entry.essential
        ? `${toolName}: disabled (essential — agents may fail without it)`
        : `${toolName}: disabled`
    };
  }

  // Managed tools: searxng + browser.
  if (toolName === 'web_search') {
    if (action === 'install' || action === 'start') {
      const r0 = await searxngPullImage({ progress: onProgress });
      if (!r0.ok && action === 'install') {
        return { ok: false, message: `searxng: ${r0.error.message}` };
      }
      const r = await searxngStart({ progress: onProgress });
      if (!r.ok) return { ok: false, message: `searxng: ${r.error.message}` };
      return { ok: true, message: `searxng: running at ${r.value.url ?? '(unknown)'}` };
    }
    if (action === 'stop') {
      const r = await searxngStop();
      if (!r.ok) return { ok: false, message: `searxng: ${r.error.message}` };
      return { ok: true, message: 'searxng: stopped' };
    }
    if (action === 'restart') {
      await searxngStop();
      const r = await searxngStart({ progress: onProgress });
      if (!r.ok) return { ok: false, message: `searxng: ${r.error.message}` };
      return { ok: true, message: `searxng: restarted at ${r.value.url ?? '(unknown)'}` };
    }
    if (action === 'remove') {
      const r = await searxngRemove();
      if (!r.ok) return { ok: false, message: `searxng: ${r.error.message}` };
      return { ok: true, message: 'searxng: container removed' };
    }
  }

  if (toolName === 'browser') {
    if (action === 'install') {
      onProgress?.('installing chromium for playwright (this can take a minute)…\n');
      return installPlaywrightChromium(onProgress);
    }
    if (action === 'stop') {
      await closeBrowser();
      return { ok: true, message: 'browser: session closed' };
    }
  }

  return { ok: false, message: `${toolName}: action "${action}" not supported` };
};
