#!/usr/bin/env node
/**
 * Dependency-free repository lint checks that complement package TypeScript
 * checks. Kept small on purpose so `pnpm lint` works without adding an
 * ESLint stack or touching the lockfile.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8'
}).trim();
process.chdir(repoRoot);

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.mts',
  '.sh',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml'
]);

const TEXT_FILENAMES = new Set([
  '.gitignore',
  'AGENTS.md',
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json'
]);

const SKIP_PREFIXES = [
  'packages/binaries/linux-x64/bin/',
  'packages/binaries/linux-arm64/bin/',
  'packages/binaries/darwin-x64/bin/',
  'packages/binaries/darwin-arm64/bin/',
  'packages/binaries/win32-x64/bin/'
];

const repoFiles = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024
})
  .split('\0')
  .filter(Boolean)
  .filter((file) => existsSync(file));

const isTextFile = (file) => {
  if (SKIP_PREFIXES.some((prefix) => file.startsWith(prefix))) return false;
  const base = file.split('/').at(-1) ?? file;
  if (TEXT_FILENAMES.has(base) || TEXT_FILENAMES.has(file)) return true;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(base.slice(dot));
};

const errors = [];
for (const file of repoFiles.filter(isTextFile)) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    errors.push(`${file}: failed to read (${err.message})`);
    continue;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    if (/[\t ]$/.test(line)) {
      errors.push(`${file}:${lineNo}: trailing whitespace`);
    }
    if (/^(<<<<<<<|=======|>>>>>>>)(\s|$)/.test(line)) {
      errors.push(`${file}:${lineNo}: unresolved merge conflict marker`);
    }
  }
}

if (errors.length > 0) {
  console.error(`repo lint failed with ${errors.length} issue${errors.length === 1 ? '' : 's'}:`);
  for (const e of errors.slice(0, 80)) console.error(`  ${e}`);
  if (errors.length > 80) console.error(`  ... ${errors.length - 80} more`);
  process.exit(1);
}

console.log(`repo lint: ${repoFiles.filter(isTextFile).length} tracked text files clean`);

const packageLints = [
  ['@atlas/core', 'packages/core'],
  ['atlas-os', 'packages/cli'],
  ['atlas-os-vscode', 'packages/vscode']
];

for (const [name, dir] of packageLints) {
  console.log(`${name} lint: tsc --noEmit`);
  execFileSync('npm', ['--prefix', dir, 'run', 'lint', '--silent'], {
    stdio: 'inherit'
  });
}