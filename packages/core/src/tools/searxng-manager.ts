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
  return { exists: true, running, ...(port !== undefined ? { port } : {}) };
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
 * Start the SearXNG container, creating it on first run with a
 * minimal in-place settings.yml that enables the JSON output format
 * (required for the `web_search` tool to parse results).
 *
 * If the container already exists but is stopped, this just runs
 * `docker start`. If it's already running, no-ops.
 *
 * Bound to 127.0.0.1 so the search box never gets exposed publicly.
 */
export const searxngStart = async (
  opts: InstallOptions = {}
): Promise<Result<SearxngStatus, AtlasError>> => {
  const pull = await searxngPullImage(opts);
  if (!pull.ok) return err(pull.error);

  const port = opts.port ?? SEARXNG_DEFAULT_PORT;
  const info = await containerInfo(SEARXNG_CONTAINER);
  if (info.exists && info.running) {
    return ok(await searxngStatus());
  }
  if (info.exists) {
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
  // 32-byte random secret for the SearXNG instance (required by upstream)
  const secret = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  ).join('');
  const r = await exec(
    'docker',
    [
      'run',
      '-d',
      '--name', SEARXNG_CONTAINER,
      '--restart', 'unless-stopped',
      '-p', `127.0.0.1:${port}:8080`,
      '-e', `SEARXNG_SECRET=${secret}`,
      '-e', `SEARXNG_BASE_URL=http://127.0.0.1:${port}/`,
      '-e', 'SEARXNG_LIMITER=false',
      '-e', 'UWSGI_WORKERS=4',
      '-e', 'UWSGI_THREADS=4',
      // Pre-enable the JSON formatter via env var; SearXNG also
      // accepts a settings.yml mount, but env-only keeps install
      // friction-free.
      '-e', 'SEARXNG_SEARCH_FORMATS=html,json',
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
