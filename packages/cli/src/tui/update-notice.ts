import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ATLAS_VERSION, atlasError, err, ok, type AtlasError, type Result } from '@atlas/core';
import { z } from 'zod';

const NPM_PACKAGE_NAME = 'atlas-os';
export const ATLAS_UPDATE_COMMAND = 'npm install -g atlas-os@latest';
const DEFAULT_TIMEOUT_MS = 1_200;

export interface AtlasUpdateNotice {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly updateCommand: string;
}

interface UpdateNoticeState {
  readonly dismissedLatestVersion?: string;
}

const UpdateNoticeStateSchema = z.object({
  dismissedLatestVersion: z.string().optional()
});

const NpmLatestSchema = z.object({
  version: z.string().min(1)
});

export interface FetchLatestPackageResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

export type FetchLatestPackage = (
  url: string,
  init: { readonly signal: AbortSignal }
) => Promise<FetchLatestPackageResponse>;

export interface CheckForAtlasUpdateOptions {
  readonly currentVersion?: string;
  readonly packageName?: string;
  readonly registryUrl?: string;
  readonly statePath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly fetchLatestPackage?: FetchLatestPackage;
}

export interface DismissAtlasUpdateNoticeOptions {
  readonly statePath?: string;
}

const defaultStatePath = (): string => join(homedir(), '.atlas', 'update-notice.json');

const latestUrlFor = (packageName: string): string =>
  `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;

const errorCode = (value: unknown): string | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  if (!('code' in value)) return undefined;
  const code = (value as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

const readState = async (
  path: string
): Promise<Result<UpdateNoticeState, AtlasError>> => {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') return ok({});
    return err(
      atlasError('STATE_PARSE_FAILED', `failed to read update notice state at ${path}`, {
        cause,
        context: { path }
      })
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch (cause) {
    return err(
      atlasError('STATE_PARSE_FAILED', `failed to parse update notice state at ${path}`, {
        cause,
        context: { path }
      })
    );
  }

  const parsed = UpdateNoticeStateSchema.safeParse(decoded);
  if (!parsed.success) {
    return err(
      atlasError('STATE_PARSE_FAILED', `invalid update notice state at ${path}`, {
        context: { path, issues: parsed.error.issues }
      })
    );
  }
  return ok(parsed.data);
};

const writeState = async (
  path: string,
  state: UpdateNoticeState
): Promise<Result<{ readonly path: string }, AtlasError>> => {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
    return ok({ path });
  } catch (cause) {
    return err(
      atlasError('STATE_WRITE_FAILED', `failed to write update notice state at ${path}`, {
        cause,
        context: { path }
      })
    );
  }
};

const defaultFetchLatestPackage: FetchLatestPackage = async (url, init) => {
  const response = await fetch(url, { signal: init.signal });
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json() as Promise<unknown>
  };
};

interface TimeoutSignal {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
  readonly timedOut: () => boolean;
}

const timeoutSignal = (
  signal: AbortSignal | undefined,
  timeoutMs: number
): TimeoutSignal => {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = (): void => controller.abort(signal?.reason);

  if (signal?.aborted) {
    forwardAbort();
  } else {
    signal?.addEventListener('abort', forwardAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('atlas update check timed out'));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    },
    timedOut: () => timedOut
  };
};

const parseVersion = (value: string): readonly [number, number, number] | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return [major, minor, patch] as const;
};

export const isNewerVersion = (candidate: string, current: string): boolean => {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (!left || !right) return false;
  for (let i = 0; i < left.length; i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined || r === undefined) return false;
    if (l > r) return true;
    if (l < r) return false;
  }
  return false;
};

export const checkForAtlasUpdate = async (
  options: CheckForAtlasUpdateOptions = {}
): Promise<Result<AtlasUpdateNotice | null, AtlasError>> => {
  const packageName = options.packageName ?? NPM_PACKAGE_NAME;
  const currentVersion = options.currentVersion ?? ATLAS_VERSION;
  const statePath = options.statePath ?? defaultStatePath();
  const state = await readState(statePath);
  if (!state.ok) return state;

  const timeout = timeoutSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: FetchLatestPackageResponse;
  try {
    response = await (options.fetchLatestPackage ?? defaultFetchLatestPackage)(
      options.registryUrl ?? latestUrlFor(packageName),
      { signal: timeout.signal }
    );
  } catch (cause) {
    const code = timeout.timedOut()
      ? 'TIMEOUT'
      : options.signal?.aborted
        ? 'CANCELLED'
        : 'PROVIDER_NETWORK';
    return err(
      atlasError(code, `failed to check latest ${packageName} version`, {
        cause,
        context: { packageName }
      })
    );
  } finally {
    timeout.cleanup();
  }

  if (!response.ok) {
    return err(
      atlasError('PROVIDER_NETWORK', `npm registry returned ${response.status} for ${packageName}`, {
        context: { packageName, status: response.status }
      })
    );
  }

  let decoded: unknown;
  try {
    decoded = await response.json();
  } catch (cause) {
    return err(
      atlasError('PROVIDER_INVALID_RESPONSE', `failed to decode npm metadata for ${packageName}`, {
        cause,
        context: { packageName }
      })
    );
  }

  const parsed = NpmLatestSchema.safeParse(decoded);
  if (!parsed.success) {
    return err(
      atlasError('PROVIDER_INVALID_RESPONSE', `invalid npm metadata for ${packageName}`, {
        context: { packageName, issues: parsed.error.issues }
      })
    );
  }

  const latestVersion = parsed.data.version;
  if (!isNewerVersion(latestVersion, currentVersion)) return ok(null);
  if (state.value.dismissedLatestVersion === latestVersion) return ok(null);

  return ok({
    packageName,
    currentVersion,
    latestVersion,
    updateCommand: ATLAS_UPDATE_COMMAND
  });
};

export const dismissAtlasUpdateNotice = async (
  latestVersion: string,
  options: DismissAtlasUpdateNoticeOptions = {}
): Promise<Result<{ readonly path: string }, AtlasError>> =>
  writeState(options.statePath ?? defaultStatePath(), {
    dismissedLatestVersion: latestVersion
  });