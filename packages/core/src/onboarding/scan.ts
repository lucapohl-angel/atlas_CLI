import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { atlasError, type AtlasError } from '../errors.js';
import { err, ok, type Result } from '../result.js';

export interface OnboardPreflight {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokensMin: number;
  readonly estimatedOutputTokensMax: number;
  readonly detected: {
    readonly languages: readonly string[];
    readonly manifests: readonly string[];
    readonly frameworks: readonly string[];
  };
  readonly costBand: 'low' | 'medium' | 'high';
}

export interface EstimateOnboardCostOptions {
  readonly cwd?: string;
  readonly maxFiles?: number;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo']);

const walkFiles = async (root: string, maxFiles: number): Promise<string[]> => {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const abs = join(dir, entry);
      let s;
      try {
        s = await stat(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) stack.push(abs);
      else if (s.isFile()) out.push(abs);
      if (out.length >= maxFiles) break;
    }
  }
  return out;
};

const extOf = (path: string): string => {
  const i = path.lastIndexOf('.');
  if (i <= 0 || i === path.length - 1) return '';
  return path.slice(i + 1).toLowerCase();
};

const detectFromManifest = (name: string, raw: string, frameworks: Set<string>): void => {
  const lower = raw.toLowerCase();
  if (name === 'package.json') {
    if (lower.includes('next')) frameworks.add('next.js');
    if (lower.includes('react')) frameworks.add('react');
    if (lower.includes('vue')) frameworks.add('vue');
    if (lower.includes('svelte')) frameworks.add('svelte');
    if (lower.includes('nest')) frameworks.add('nestjs');
    if (lower.includes('express')) frameworks.add('express');
  }
  if (name === 'pyproject.toml' || name === 'requirements.txt') {
    if (lower.includes('django')) frameworks.add('django');
    if (lower.includes('fastapi')) frameworks.add('fastapi');
    if (lower.includes('flask')) frameworks.add('flask');
  }
};

const languageForExt = (ext: string): string | undefined => {
  const map: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TypeScript',
    js: 'JavaScript',
    jsx: 'JavaScript',
    py: 'Python',
    go: 'Go',
    rs: 'Rust',
    java: 'Java',
    rb: 'Ruby',
    php: 'PHP',
    md: 'Markdown',
    yml: 'YAML',
    yaml: 'YAML',
    json: 'JSON',
    toml: 'TOML'
  };
  return map[ext];
};

export const estimateOnboardCost = async (
  opts: EstimateOnboardCostOptions = {}
): Promise<Result<OnboardPreflight, AtlasError>> => {
  const cwd = opts.cwd ?? process.cwd();
  const maxFiles = opts.maxFiles ?? 5000;
  let files: string[];
  try {
    files = await walkFiles(cwd, maxFiles);
  } catch (e) {
    return err(atlasError('ONBOARDING_SCAN_FAILED', `failed to scan ${cwd}`, { cause: e }));
  }

  let totalBytes = 0;
  const langs = new Set<string>();
  const manifests = new Set<string>();
  const frameworks = new Set<string>();

  for (const path of files) {
    let s;
    try {
      s = await stat(path);
    } catch {
      continue;
    }
    totalBytes += s.size;
    const ext = extOf(path);
    const lang = languageForExt(ext);
    if (lang) langs.add(lang);
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (
      base === 'package.json' ||
      base === 'pnpm-workspace.yaml' ||
      base === 'requirements.txt' ||
      base === 'pyproject.toml' ||
      base === 'go.mod' ||
      base === 'Cargo.toml'
    ) {
      manifests.add(base);
      try {
        const raw = await readFile(path, 'utf8');
        detectFromManifest(base, raw, frameworks);
      } catch {
        // Best-effort only.
      }
    }
  }

  const estimatedInputTokens = Math.ceil(totalBytes / 4);
  const estimatedOutputTokensMin = Math.max(1000, Math.ceil(estimatedInputTokens * 0.04));
  const estimatedOutputTokensMax = Math.max(4000, Math.ceil(estimatedInputTokens * 0.12));
  const total = estimatedInputTokens + estimatedOutputTokensMax;
  const costBand = total > 300_000 ? 'high' : total > 100_000 ? 'medium' : 'low';

  return ok({
    fileCount: files.length,
    totalBytes,
    estimatedInputTokens,
    estimatedOutputTokensMin,
    estimatedOutputTokensMax,
    detected: {
      languages: [...langs].sort(),
      manifests: [...manifests].sort(),
      frameworks: [...frameworks].sort()
    },
    costBand
  });
};

export interface RepoMapResult {
  readonly path: string;
  readonly filesScanned: number;
}

export interface WriteRepoMapOptions {
  readonly cwd?: string;
  readonly outPath?: string;
  readonly maxFiles?: number;
}

export const writeRepoMap = async (
  opts: WriteRepoMapOptions = {}
): Promise<Result<RepoMapResult, AtlasError>> => {
  const cwd = opts.cwd ?? process.cwd();
  const outPath = opts.outPath ?? join(cwd, 'docs', 'repo-map.md');
  const files = await walkFiles(cwd, opts.maxFiles ?? 2000);

  const rows = files
    .map((f) => relative(cwd, f))
    .filter((f) => !f.startsWith('.atlas/') && !f.startsWith('docs/.handoffs/'))
    .sort((a, b) => a.localeCompare(b));

  const pf = await estimateOnboardCost({ cwd, maxFiles: opts.maxFiles });
  if (!pf.ok) return pf;

  const body = [
    '# Repository Map',
    '',
    'Generated by Atlas `/onboard --map-only`.',
    '',
    '## Preflight',
    '',
    `- Files scanned: ${rows.length}`,
    `- Estimated input tokens: ~${pf.value.estimatedInputTokens}`,
    `- Cost band: ${pf.value.costBand}`,
    `- Languages: ${pf.value.detected.languages.join(', ') || '(none detected)'}`,
    `- Framework hints: ${pf.value.detected.frameworks.join(', ') || '(none detected)'}`,
    '',
    '## Files',
    '',
    ...rows.map((r) => `- ${r}`)
  ].join('\n');

  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, body + '\n', 'utf8');
  } catch (e) {
    return err(atlasError('ONBOARDING_WRITE_FAILED', `failed to write ${outPath}`, { cause: e }));
  }

  return ok({ path: outPath, filesScanned: rows.length });
};
