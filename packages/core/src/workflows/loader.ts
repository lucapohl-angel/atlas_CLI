/**
 * Loader for `chains.yaml`. Resolution order:
 *   1. explicit `dir` option (tests).
 *   2. `<cwd>/.atlas/workflows/chains.yaml` (project-local override).
 *   3. `~/.atlas/workflows/chains.yaml` (user default, installed by `atlas init`).
 *   4. built-in defaults baked into the binary (`DEFAULT_CHAINS`).
 *
 * Missing files fall through silently to the next layer; malformed YAML
 * surfaces as a CHAIN_PARSE_FAILED error so users see config bugs.
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import { BUILTIN_WORKFLOWS } from '../builtins/workflows.js';
import {
  ChainsFileSchema,
  type ChainsFile,
  type ChainStep,
  type WorkflowActivation
} from './types.js';

export interface LoadChainsOptions {
  readonly dir?: string;
  readonly cwd?: string;
  readonly home?: string;
}

const emptyActivation = (): WorkflowActivation => ({
  prepend: [],
  append: [],
  persistentFacts: [],
  onComplete: undefined
});

const mergeActivation = (
  base: WorkflowActivation,
  next?: WorkflowActivation
): WorkflowActivation => {
  if (!next) return base;
  return {
    prepend: next.prepend.length > 0 ? next.prepend : base.prepend,
    append: next.append.length > 0 ? next.append : base.append,
    persistentFacts: next.persistentFacts.length > 0 ? next.persistentFacts : base.persistentFacts,
    onComplete: next.onComplete ?? base.onComplete
  };
};

const mergeChains = (
  base: readonly ChainStep[],
  next: readonly ChainStep[]
): ChainStep[] => {
  const map = new Map<string, ChainStep>();
  for (const step of base) {
    map.set(`${step.fromAgent}|${step.command ?? '*'}`, step);
  }
  for (const step of next) {
    const key = `${step.fromAgent}|${step.command ?? '*'}`;
    const prev = map.get(key);
    map.set(key, prev ? { ...prev, ...step } : step);
  }
  return [...map.values()];
};

const fileExists = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};

export const parseChainsFile = (
  raw: string,
  path: string
): Result<ChainsFile, AtlasError> => {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    return err(
      atlasError('CHAIN_PARSE_FAILED', `failed to parse chains file at ${path}`, {
        cause: e,
        context: { path }
      })
    );
  }
  const result = ChainsFileSchema.safeParse(parsed ?? {});
  if (!result.success) {
    return err(
      atlasError('CHAIN_PARSE_FAILED', `invalid chains file at ${path}`, {
        context: { path, issues: result.error.issues }
      })
    );
  }
  return ok(result.data);
};

export const parseChains = (
  raw: string,
  path: string
): Result<readonly ChainStep[], AtlasError> => {
  const parsed = parseChainsFile(raw, path);
  if (!parsed.ok) return parsed;
  return ok(parsed.value.chains);
};

const readChainsFile = async (path: string): Promise<Result<ChainsFile, AtlasError>> => {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    return err(
      atlasError('CHAIN_PARSE_FAILED', `failed to read chains file at ${path}`, { cause: e })
    );
  }
  return parseChainsFile(raw, path);
};

const loadBuiltinChains = (): Result<ChainsFile, AtlasError> => {
  const builtin = BUILTIN_WORKFLOWS.find((f) => f.relPath.endsWith('chains.yaml'));
  if (!builtin) return ok({ version: 1, chains: [], activation: emptyActivation() });
  const parsed = parseChainsFile(builtin.content, `builtin:${builtin.relPath}`);
  if (!parsed.ok) return parsed;
  return parsed;
};

export const loadWorkflowConfig = async (
  opts: LoadChainsOptions = {}
): Promise<Result<ChainsFile, AtlasError>> => {
  const builtinR = loadBuiltinChains();
  if (!builtinR.ok) return builtinR;

  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const layers = [
    join(home, '.atlas', 'workflows', 'chains.yaml'),
    join(cwd, '.atlas', 'workflows', 'chains.yaml'),
    ...(opts.dir ? [join(opts.dir, 'chains.yaml')] : [])
  ];

  let merged: ChainsFile = {
    version: builtinR.value.version,
    chains: builtinR.value.chains,
    activation: mergeActivation(emptyActivation(), builtinR.value.activation)
  };

  for (const path of layers) {
    if (!(await fileExists(path))) continue;
    const parsed = await readChainsFile(path);
    if (!parsed.ok) return parsed;
    merged = {
      version: parsed.value.version,
      chains: mergeChains(merged.chains, parsed.value.chains),
      activation: mergeActivation(merged.activation ?? emptyActivation(), parsed.value.activation)
    };
  }
  return ok(merged);
};

export const loadChains = async (
  opts: LoadChainsOptions = {}
): Promise<Result<readonly ChainStep[], AtlasError>> => {
  const cfg = await loadWorkflowConfig(opts);
  if (!cfg.ok) return cfg;
  return ok(cfg.value.chains);
};

/**
 * Look up the next step for `(fromAgent, command)`. A specific
 * `command` match wins over a wildcard (`command` undefined) entry from
 * the same `fromAgent`.
 */
export const lookupChain = (
  chains: readonly ChainStep[],
  fromAgent: string,
  command?: string
): ChainStep | undefined => {
  let wildcard: ChainStep | undefined;
  for (const step of chains) {
    if (step.fromAgent !== fromAgent) continue;
    if (step.command && command && step.command === command) return step;
    if (!step.command) wildcard = wildcard ?? step;
  }
  return wildcard;
};
