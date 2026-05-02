/**
 * SearXNG management — start/stop/status of a local self-hosted
 * SearXNG metasearch instance, used as the sole `web_search` backend.
 *
 * Why local SearXNG:
 *   - 100% free, no API keys, no monthly quota
 *   - Privacy: queries never leave your machine to a search-as-a-service
 *   - Aggregates Google + Bing + DDG + Wikipedia + many others
 *
 * The container is run as a single Docker process named
 * `atlas-searxng` and exposed on `localhost:${port}` (default 8080).
 * `web_search` reads `SEARXNG_URL` from the environment if set,
 * otherwise defaults to `http://127.0.0.1:8080`. We bind to 127.0.0.1
 * only — never the public interface — to avoid accidentally exposing
 * the search box.
 *
 * All operations shell out to the `docker` binary. No daemon-API
 * usage so users can also run the container by hand and Atlas just
 * reports its state.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';

export const SEARXNG_CONTAINER = 'atlas-searxng';
export const SEARXNG_IMAGE = 'docker.io/searxng/searxng:latest';
export const SEARXNG_DEFAULT_PORT = 8080;

export interface SearxngStatus {
  readonly dockerInstalled: boolean;
  readonly imagePulled: boolean;
  readonly containerExists: boolean;
  readonly running: boolean;
  readonly port?: number;
  readonly url?: string;
}

interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a child process and capture stdout/stderr. Never throws — any
 * spawn error is folded into `code: -1` with the message in stderr.
 */
const exec = (cmd: string, args: readonly string[], timeoutMs = 30_000): Promise<ExecResult> =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

const dockerAvailable = async (): Promise<boolean> => {
  const r = await exec('docker', ['version', '--format', '{{.Server.Version}}'], 5_000);
  return r.code === 0;
};

const imageExists = async (image: string): Promise<boolean> => {
  const r = await exec('docker', ['image', 'inspect', image], 5_000);
  return r.code === 0;
};

interface ContainerInfo {
  readonly exists: boolean;
  readonly running: boolean;
  readonly port?: number;
  /**
   * The host path that the container has mounted at `/etc/searxng`,
   * if any. Used to detect containers created before the JSON-format
   * fix so we can recreate them with the correct settings.yml.
   */
  readonly configMount?: string;
}

const containerInfo = async (name: string): Promise<ContainerInfo> => {
  const r = await exec(
    'docker',
    ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}|{{.State}}|{{.Ports}}'],
    5_000
  );
  if (r.code !== 0) return { exists: false, running: false };
  const line = r.stdout.split('\n').find((l) => l.trim().length > 0);
  if (!line) return { exists: false, running: false };
  const [, state, ports] = line.split('|');
  const running = (state ?? '').toLowerCase() === 'running';
  // Parse "127.0.0.1:8080->8080/tcp, ..." → 8080
  let port: number | undefined;
  const m = (ports ?? '').match(/127\.0\.0\.1:(\d+)->/);
  if (m && m[1]) port = Number(m[1]);

  // Inspect the mount list so we can tell if /etc/searxng is bound
  // to a host directory (i.e. our settings.yml is in use). We only
  // need the source path so a single Go-template inspect call works.
  let configMount: string | undefined;
  const inspect = await exec(
    'docker',
    [
      'inspect',
      '--format',
      '{{range .Mounts}}{{if eq .Destination "/etc/searxng"}}{{.Source}}{{end}}{{end}}',
      name
    ],
    5_000
  );
  if (inspect.code === 0) {
    const src = inspect.stdout.trim();
    if (src.length > 0) configMount = src;
  }

  return {
    exists: true,
    running,
    ...(port !== undefined ? { port } : {}),
    ...(configMount !== undefined ? { configMount } : {})
  };
};

/** Read the current state of the SearXNG container. */
export const searxngStatus = async (): Promise<SearxngStatus> => {
  const dockerInstalled = await dockerAvailable();
  if (!dockerInstalled) {
    return { dockerInstalled: false, imagePulled: false, containerExists: false, running: false };
  }
  const [imagePulled, info] = await Promise.all([
    imageExists(SEARXNG_IMAGE),
    containerInfo(SEARXNG_CONTAINER)
  ]);
  return {
    dockerInstalled,
    imagePulled,
    containerExists: info.exists,
    running: info.running,
    ...(info.port !== undefined ? { port: info.port, url: `http://127.0.0.1:${info.port}` } : {})
  };
};

export interface InstallOptions {
  readonly port?: number;
  /** Print docker output to stderr while pulling/creating. */
  readonly progress?: (line: string) => void;
}

const writeProgress = (opts: InstallOptions | undefined, line: string): void => {
  if (opts?.progress) opts.progress(line);
};

/**
 * Pull the SearXNG image if it isn't already present. Idempotent.
 *
 * Returns `URL_BLOCKED` style errors (re-using the existing tool
 * error code set) — actually plain TOOL_EXECUTION_FAILED so callers
 * can render them.
 */
export const searxngPullImage = async (
  opts: InstallOptions = {}
): Promise<Result<void, AtlasError>> => {
  if (!(await dockerAvailable())) {
    return err(
      atlasError('TOOL_EXECUTION_FAILED', 'docker is not installed or the daemon is not running')
    );
  }
  if (await imageExists(SEARXNG_IMAGE)) return ok(undefined);
  writeProgress(opts, `pulling ${SEARXNG_IMAGE} (this can take a minute)…\n`);
  const r = await exec('docker', ['pull', SEARXNG_IMAGE], 600_000);
  if (r.code !== 0) {
    return err(
      atlasError(
        'TOOL_EXECUTION_FAILED',
        `docker pull ${SEARXNG_IMAGE} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`
      )
    );
  }
  return ok(undefined);
};

/**
 * Path to the host-side SearXNG config directory we mount into the
 * container at `/etc/searxng`. We keep it under `~/.atlas/` so it
 * survives container removal and so the user can edit settings.yml
 * by hand if they want to tweak engines / preferences.
 */
const searxngConfigDir = (): string => join(homedir(), '.atlas', 'searxng');

/**
 * Random 32-byte hex secret. Reused across (re)creates by stashing
 * it inside the config dir; otherwise every recreate would invalidate
 * existing user preferences cookies.
 */
const loadOrCreateSecret = async (configDir: string): Promise<string> => {
  const path = join(configDir, '.secret');
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (existing.length === 64) return existing;
  } catch {
    // fall through to mint a new one
  }
  const secret = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  ).join('');
  await writeFile(path, secret + '\n', { mode: 0o600 });
  return secret;
};

/**
 * Write `settings.yml` to the host config dir. We inherit defaults so
 * we don't have to enumerate all upstream engines, then override:
 *   - server.secret_key — required by upstream, no default
 *   - server.limiter: false — turn off rate-limit-against-bots, since
 *     the only client is our own loop on localhost
 *   - server.public_instance: false — same reason
 *   - search.formats: [html, json] — REQUIRED for `web_search`; the
 *     default settings only enable html, which is why a fresh
 *     container was returning HTTP 403 to format=json requests.
 *
 * The file is rewritten on every start to pick up our latest defaults
 * — the user's secret is preserved (loaded from ~/.atlas/searxng/.secret).
 */
const writeSettings = async (configDir: string, secret: string): Promise<string> => {
  const settingsPath = join(configDir, 'settings.yml');
  const yaml = [
    '# Managed by atlas-cli — do not edit unless you want to fork off.',
    "# Re-running `atlas searxng start` (or the `/tools` UI) overwrites this file",
    '# but preserves your secret in .secret next to it.',
    'use_default_settings: true',
    'general:',
    '  debug: false',
    '  instance_name: "atlas-searxng"',
    'server:',
    `  secret_key: "${secret}"`,
    '  limiter: false',
    '  image_proxy: false',
    '  public_instance: false',
    'search:',
    '  safe_search: 0',
    '  autocomplete: ""',
    '  default_lang: "auto"',
    '  formats:',
    '    - html',
    '    - json',
    'ui:',
    '  static_use_hash: true',
    ''
  ].join('\n');
  await writeFile(settingsPath, yaml, 'utf8');
  return settingsPath;
};

/**
 * Ensure the host config dir exists and contains an up-to-date
 * settings.yml + a stable secret. Returns the absolute path of the
 * dir to bind-mount into the container.
 */
const ensureConfigDir = async (): Promise<string> => {
  const dir = searxngConfigDir();
  await mkdir(dir, { recursive: true });
  const secret = await loadOrCreateSecret(dir);
  await writeSettings(dir, secret);
  return dir;
};

/**
 * Start the SearXNG container.
 *
 * Behavior matrix:
 *   - no container       → create with mounted settings.yml + start
 *   - running, mounted   → no-op
 *   - stopped, mounted   → docker start
 *   - exists, NOT mounted (legacy install before the JSON fix)
 *                        → remove + recreate (auto-heal)
 *
 * The auto-heal branch is the important one: users who hit the
 * HTTP 403 from the first ship of this feature get fixed silently
 * the next time they run `web_search` install / start.
 *
 * Bound to 127.0.0.1 only so the search box never gets exposed.
 */
export const searxngStart = async (
  opts: InstallOptions = {}
): Promise<Result<SearxngStatus, AtlasError>> => {
  const pull = await searxngPullImage(opts);
  if (!pull.ok) return err(pull.error);

  const port = opts.port ?? SEARXNG_DEFAULT_PORT;
  const configDir = await ensureConfigDir();
  const info = await containerInfo(SEARXNG_CONTAINER);

  // Auto-heal: a container that exists but doesn't have our config
  // dir mounted is from the buggy first release that returned 403 on
  // format=json. Tear it down and recreate against the correct
  // settings.yml. The user's host-side .secret is preserved so
  // existing preferences cookies still work.
  if (info.exists && info.configMount !== configDir) {
    writeProgress(opts, 'detected legacy SearXNG container without settings.yml mount — recreating…\n');
    if (info.running) {
      await exec('docker', ['stop', SEARXNG_CONTAINER], 30_000);
    }
    const rmRes = await exec('docker', ['rm', SEARXNG_CONTAINER], 15_000);
    if (rmRes.code !== 0) {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          `failed to remove legacy ${SEARXNG_CONTAINER}: ${rmRes.stderr.trim()}`
        )
      );
    }
    // fall through into create branch below
  } else if (info.exists && info.running) {
    return ok(await searxngStatus());
  } else if (info.exists) {
    writeProgress(opts, `starting existing container ${SEARXNG_CONTAINER}…\n`);
    const r = await exec('docker', ['start', SEARXNG_CONTAINER], 30_000);
    if (r.code !== 0) {
      return err(
        atlasError(
          'TOOL_EXECUTION_FAILED',
          `docker start ${SEARXNG_CONTAINER} failed: ${r.stderr.trim()}`
        )
      );
    }
    return ok(await searxngStatus());
  }

  writeProgress(opts, `creating container ${SEARXNG_CONTAINER} on 127.0.0.1:${port}…\n`);
  const r = await exec(
    'docker',
    [
      'run',
      '-d',
      '--name', SEARXNG_CONTAINER,
      '--restart', 'unless-stopped',
      '-p', `127.0.0.1:${port}:8080`,
      // Mount our config dir so /search?format=json works out of the
      // box. This is the actual fix for the original HTTP 403.
      '-v', `${configDir}:/etc/searxng`,
      '-e', `SEARXNG_BASE_URL=http://127.0.0.1:${port}/`,
      '-e', 'UWSGI_WORKERS=4',
      '-e', 'UWSGI_THREADS=4',
      SEARXNG_IMAGE
    ],
    60_000
  );
  if (r.code !== 0) {
    return err(
      atlasError(
        'TOOL_EXECUTION_FAILED',
        `docker run for SearXNG failed: ${r.stderr.trim() || r.stdout.trim()}`
      )
    );
  }
  return ok(await searxngStatus());
};

/** Stop the SearXNG container if running. Leaves the container in place for fast restart. */
export const searxngStop = async (): Promise<Result<void, AtlasError>> => {
  if (!(await dockerAvailable())) {
    return err(atlasError('TOOL_EXECUTION_FAILED', 'docker is not installed'));
  }
  const info = await containerInfo(SEARXNG_CONTAINER);
  if (!info.exists || !info.running) return ok(undefined);
  const r = await exec('docker', ['stop', SEARXNG_CONTAINER], 30_000);
  if (r.code !== 0) {
    return err(
      atlasError('TOOL_EXECUTION_FAILED', `docker stop ${SEARXNG_CONTAINER} failed: ${r.stderr.trim()}`)
    );
  }
  return ok(undefined);
};

/** Remove the container (next start will recreate it). */
export const searxngRemove = async (): Promise<Result<void, AtlasError>> => {
  if (!(await dockerAvailable())) {
    return err(atlasError('TOOL_EXECUTION_FAILED', 'docker is not installed'));
  }
  const info = await containerInfo(SEARXNG_CONTAINER);
  if (!info.exists) return ok(undefined);
  if (info.running) {
    const stop = await exec('docker', ['stop', SEARXNG_CONTAINER], 30_000);
    if (stop.code !== 0) {
      return err(
        atlasError('TOOL_EXECUTION_FAILED', `docker stop failed: ${stop.stderr.trim()}`)
      );
    }
  }
  const r = await exec('docker', ['rm', SEARXNG_CONTAINER], 15_000);
  if (r.code !== 0) {
    return err(atlasError('TOOL_EXECUTION_FAILED', `docker rm failed: ${r.stderr.trim()}`));
  }
  return ok(undefined);
};

/**
 * Resolve the URL `web_search` should call. Honors `SEARXNG_URL` env
 * override; otherwise uses the local container's bound port. Returns
 * an error when nothing is reachable so the tool can surface a
 * setup hint instead of silently failing.
 */
export const resolveSearxngUrl = async (): Promise<Result<string, AtlasError>> => {
  const override = (process.env['SEARXNG_URL'] ?? '').trim().replace(/\/$/, '');
  if (override) return ok(override);
  const status = await searxngStatus();
  if (status.running && status.url) return ok(status.url);
  return err(
    atlasError(
      'TOOL_EXECUTION_FAILED',
      'web_search: SearXNG is not running. Run `/searxng start` in the TUI or `atlas searxng start` in your shell. (See `/searxng status` for diagnostics.)'
    )
  );
};
