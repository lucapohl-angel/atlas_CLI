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
import { ChainsFileSchema, type ChainStep } from './types.js';

export interface LoadChainsOptions {
  readonly dir?: string;
  readonly cwd?: string;
  readonly home?: string;
}

const fileExists = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};

export const parseChains = (
  raw: string,
  path: string
): Result<readonly ChainStep[], AtlasError> => {
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
  return ok(result.data.chains);
};

export const loadChains = async (
  opts: LoadChainsOptions = {}
): Promise<Result<readonly ChainStep[], AtlasError>> => {
  const candidates: string[] = [];
  if (opts.dir) candidates.push(join(opts.dir, 'chains.yaml'));
  const cwd = opts.cwd ?? process.cwd();
  candidates.push(join(cwd, '.atlas', 'workflows', 'chains.yaml'));
  const home = opts.home ?? homedir();
  candidates.push(join(home, '.atlas', 'workflows', 'chains.yaml'));

  for (const path of candidates) {
    if (!(await fileExists(path))) continue;
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (e) {
      return err(
        atlasError('CHAIN_PARSE_FAILED', `failed to read chains file at ${path}`, { cause: e })
      );
    }
    return parseChains(raw, path);
  }
  return ok([]);
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
